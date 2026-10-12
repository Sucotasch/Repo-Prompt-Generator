# Аудит desktop-версии (Tauri)

**Дата:** 2026-10-12 · **Скоуп:** `apps/desktop/src-tauri` (Rust, конфиги, capabilities) + десктоп-специфичные пути общих пакетов
**Метод:** полное чтение lib.rs (803 строки) и всех файлов скоупа; инструментальная проверка контрактов команд `.unlazy/audit/contract-check.mjs` (15 команд / 15 зарегистрировано / 17 call-sites, негативный контроль срабатывает); ручная трассировка Cancel-флоу и прокси.

**Итог: findings_total=27 — все закрыты** (19 из кодового аудита + 4 + 2 + 2 из раундов ручных тестов и пользовательских запросов). Главный системный вывод: оба класса ошибок, которые мы ловили вручную (молча съеденные аргументы команд и неработающий прокси), теперь закрыты и покрыты проверяемым инструментом.

**Прочитано полностью (скоуп аудита):** `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/capabilities/default.json`, `apps/desktop/package.json`, `apps/desktop/src/main.tsx`, `packages/core/src/utils/tauriAdapter.ts`, `packages/core/src/utils/tauriFetch.ts`, `packages/core/src/utils/fileSystem.ts`, `packages/core/src/services/openaiCompatibleService.ts`, `packages/core/src/services/ollamaService.ts`, `packages/core/src/services/geminiService.ts`, `packages/core/src/services/ragService.ts`, `packages/ui/src/App.tsx` (десктоп-ветки).

## Контракты команд (новый постоянный инструмент)

`node .unlazy/audit/contract-check.mjs` извлекает все `#[tauri::command]`-функции (с учётом `rename_all`), список `generate_handler!` и все `tauriInvoke`-вызовы, и сверяет имена аргументов. Сейчас: `INVENTORY OK` (0 расхождений). Инструмент валидирован негативным контролем: подсовывание `bogus_probe_arg` даёт `PROBLEM: DROPPED_ARG`, чистое дерево проходит. Рекомендация: прогонять перед каждым релизом — это дешёвая страховка от самого коварного класса багов Tauri (аргумент молча приходит как `None`).

## HIGH

| ID | Статус | Находка |
|----|--------|---------|
| F-01 | ИСПРАВЛЕНО (2026-10-12) | **fetch_github_repo: статус ответа tree не проверяется** — `apps/desktop/src-tauri/src/lib.rs:276`. После `send_async` сразу читается body и парсится JSON; при 403 (лимит GitHub API — 60 запросов/час без токена!), 404 или любой ошибке тело `{"message": "..."}` парсится успешно, `tree_json["tree"]` = null → `unwrap_or_default()` → **тихий пустой репозиторий**: только README, ноль файлов, ни одной ошибки. Фикс: после `send_async` проверить `tree_res.status().is_success()`, при ошибке вернуть `Err` с кодом и подсказкой про rate-limit/токен. |
| F-02 | ИСПРАВЛЕНО (2026-10-12) | **Cancel — декоративный.** `AbortController` создаётся (`packages/ui/src/App.tsx:883`), но `signal` не потребляет никто: хелпер `delay` (`App.tsx:855`) не вызывается ни разу, ветки генерации сигнал не принимают — `generate_final_prompt_with_ollama` (`packages/core/src/services/ollamaService.ts:48`) и `ai_network_request` отмены не поддерживают. Кнопка Cancel лишь сбрасывает `loading` — генерация продолжается в фоне и по завершении **всё равно пишет результат в панель и в историю** (эффект сохранения на `prompt`). Фикс (минимальный): в `handleGenerate` после `await` проверить `signal.aborted` и выйти до `setPrompt`; полный фикс — прокидывать отмену в Rust (tokio `CancellationToken` на команду). |

## MEDIUM

| ID | Статус | Находка |
|----|--------|---------|
| F-03 | ИСПРАВЛЕНО (эта сессия) | Поле Global Proxy Address было no-op: env-переменные ставились вокруг сборки клиента, но libcurl читает их в момент запроса — уже после снятия. Теперь явный `builder.proxy(...)` (`apps/desktop/src-tauri/src/lib.rs:743-770`), пустое поле = гарантированно прямое соединение (`proxy(None)` отключает и env-детект). Верифицировано тестовым бинарем: proxy 127.0.0.1:2080 → HTTP 200 за 1.5с. |
| F-04 | ИСПРАВЛЕНО (эта сессия) | Молча съеденные аргументы команд: `set_app_config.gemini_key` (Gemini-ключ из UI не доходил до Rust — маскировалось env-ключом) и `ai_network_request.timeout_secs` (per-request таймаут не применялся). Фикс: `rename_all = "snake_case"` на обеих командах; покрытие — contract-check (см. выше). |
| F-05 | ИСПРАВЛЕНО (2026-10-12) | `fetch_github_repo` без per-request таймаута: все запросы идут через общий клиент (3600с, `lib.rs:733`), зависший GitHub-коннект блокирует генерацию на час без отмены. Фикс: `.timeout(Duration::from_secs(30))` на каждый билдер запросов (механизм уже есть — см. `ai_network_request`). |
| F-06 | ИСПРАВЛЕНО (2026-10-12) | `stop_ollama` убивает **все** процессы `ollama.exe` в системе, если приложение само стартовало хоть один (`lib.rs:472-496`): можно убить пользовательский инстанс, запущенный независимо. Фикс: хранить `child.id()` в `AppState` и убивать только этот PID. |
| F-07 | ИСПРАВЛЕНО (2026-10-12) | `ai_network_request` — неограниченный сетевой мост (любой URL, любые заголовки) при `csp: null` (`apps/desktop/src-tauri/tauri.conf.json:23`). Компрометация webview = канал эксфильтрации. Hardening: allowlist доменов (github/gemini/ollama/пресеты провайдеров) или хотя бы CSP `default-src 'self'`. |
| F-08 | ИСПРАВЛЕНО (2026-10-12) | `url.replace("localhost", "127.0.0.1")` заменяет **подстроку в любом месте** URL (`lib.rs:653`, а также 500, 514, 551, 601): хост вида `api.localhost-proxy.io` молча превращается в `api.127.0.0.1-proxy.io`. Фикс: заменять только хост — `replacen("://localhost", "://127.0.0.1", 1)` или парсить Uri. |

## LOW

| ID | Находка |
|----|---------|
| F-10 | ИСПРАВЛЕНО (2026-10-12) — `packages/core/src/utils/tauriFetch.ts` — мёртвый код (ноль вызовов, только реэкспорт из barrel): скрытый баг с `headers as Record<string,string>` (Headers/массив молча дадут пустые заголовки) и без таймаута. Удалить или убрать из `index.ts`. |
| F-11 | ИСПРАВЛЕНО (2026-10-12) — Мёртвая поверхность: `@tauri-apps/plugin-shell` (npm + Rust-плагин + `shell:default`) не импортируется нигде после редизайна; `fs:default` в capabilities при том, что из JS plugin-fs не используется (сохранение — свой `save_text_file`). Least privilege: убрать оба. |
| F-12 | ИСПРАВЛЕНО (2026-10-12) — Логи печатают префикс API-ключа: `println!("[Gemini] Using key: {}...")` (`lib.rs:82`), `[Init] … {} (len:)` (`lib.rs:728`). Заменить на «key present (len N)» без символов. |
| F-13 | ИСПРАВЛЕНО (2026-10-12) — Фильтр `name.starts_with(".git")` (`lib.rs:164`) прячет и `.github` — воркфлоу-файлы не попадают в анализ локальных репозиториев. |
| F-14 | ИСПРАВЛЕНО (2026-10-12) — `ollama_fetch_models` при HTTP-ошибке возвращает `Ok(vec![])` (`lib.rs:521-524`) — серверная ошибка маскируется под «моделей нет». Лучше `Err`. |
| F-15 | ИСПРАВЛЕНО (2026-10-12) — Стартовые клиенты без `connect_timeout` (`lib.rs:733-741`); `ollama_client` живёт всю сессию — для удалённого LM Studio зависание коннекта не ограничено. |
| F-16 | ИСПРАВЛЕНО (2026-10-12) — Срезы `&key[..min(4,len)]` (`lib.rs:705, 715, 729`) паникуют на мультибайтной UTF-8 границе (теоретически: ключ из UI не ASCII). Использовать char-safe усечение. |
| F-17 | ИСПРАВЛЕНО (2026-10-12) — `lint` desktop — no-op (`apps/desktop/package.json`), хотя `npx tsc --noEmit` настроен и проходит. Включить в скрипт — сейчас workspace-lint не проверяет половину фронтенда. |
| F-18 | ИСПРАВЛЕНО (2026-10-12) — Дефолтные модели дублируются строками «gemini-3-flash-preview» / «gemini-3.1-pro-preview» (`lib.rs:84, 123`) — вынести в const. |
| F-19 | РЕШЕНО (без изменений) — `apps/desktop/net_debug/` — страйт-крейт вне сборки (задокументирован в AGENTS.md); не трогать, но помнить при полных `cargo`-проходках. |

## Что уже сделано в этой сессии (сводка)

- F-03, F-04 — исправлены и верифицированы (лог живого приложения: «timeout 30s», «AUTO-TEST OK: 80 models in 612ms»).
- Per-request таймаут для `/models` (30с) + JS-страховка (40с) — «вечный fetching» невозможен.
- window-state: позиция/размер/развёрнутость сохраняются (`.window-state.json` в `%APPDATA%\com.sucotasch.repo-prompt-generator\`), проверено живым запуском.
- Нейтральная системная тема, Appearance-группа, Reset all settings.

## Новая находка (найдена при проработке решений)

| ID | Статус | Находка |
|----|--------|---------|
| F-20 | ИСПРАВЛЕНО (2026-10-12) | Команда `scan_local_repository` (`lib.rs:154-197`) — **мёртвый код**: ноль JS-вызовов (проверено grep по packages/ и apps/). Desktop берёт локальные файлы через `webkitdirectory`-инпут (браузерный FileList внутри WebView2) + `processLocalFolder` — «нативный FS» используется только для сохранения (свой `save_text_file` + plugin-dialog). Запись AGENTS.md «Desktop uses plugin-fs for native FS access» устарела и вводит в заблуждение. |

## Решения (предварительные, проверены прототипами/трассировкой; код приложения не менялся)

Обозначения проверки: **[прототип]** — выполнен отдельный тест на реальных данных; **[трассировка]** — все пути вызова прослежены по исходникам; **[живое доказательство]** — механизм уже работает в запущенном приложении.

### SOL-F-01 — статус tree-ответа
Решение: после `send_async` для tree (`lib.rs:276`) добавить проверку `tree_res.status().is_success()`; при ошибке вернуть `Err(format!("GitHub API error {status}: {body_message} (rate limit? add a token)"))`, вытащив `"message"` из тела. Проверка: [трассировка] единственный потребитель — `handleGenerate`, его catch показывает error pill; контракт `Ok(GithubRepoData)` не меняется. Последствия: репозитории, которые раньше «работали пустыми», станут честной ошибкой — целевое поведение; потеря функционала отсутствует.

### SOL-F-02 — честный Cancel (двухуровневое)
Уровень 1 (рекомендуемый, только фронтенд): счётчик поколений `generationRef = useRef(0)`; в `handleGenerate` — `const genId = ++generationRef.current`, на границах фаз (после fetch repo, после RAG, после суммаризации, перед финальной генерацией) проверка `genId !== generationRef.current || abortControllerRef.current?.signal.aborted` → выброс маркера `__CANCELLED__`; в catch — отдельная ветка: статус «Generation cancelled» без красной пилюли; `setPrompt` не вызывается → эффект истории не срабатывает (F-09 закрывается автоматически). Cancel-кнопка дополнительно вызывает `abort()`. Проверка: [трассировка] все 6 ранних return-ов `handleGenerate` сохраняют семантику; конфликт с tokenWarning-флоу отсутствует (там уже есть ранний выход до `setPrompt`). Последствия: сетевой запрос физически продолжается (isahc не отменяет in-flight из JS) — расход токенов локальной модели, но UI и история честны; уровень 2 (настоящая отмена через tokio CancellationToken на командах) — отдельная итерация, помечено как future work.

### SOL-F-05 — таймауты GitHub-пути
`fetch_github_repo`: `.timeout(Duration::from_secs(30))` на все 5 билдеров (info/tree/readme/deps/source). Механизм доказан: per-request `.timeout()` работает в живом приложении (лог «timeout 30s», ai_network_request). Дополнительно: агentic-загрузка файлов в `githubService.ts:123` (`ai_network_request`) получает `timeout_secs: 30` — сейчас там дефолтные 3600с. Последствия: лимит на ЗАПРОС, не на суммарную выборку 200 файлов; параллельность JoinSet сохраняется.

### SOL-F-06 — точечный stop_ollama
`AppState` + `Mutex<Option<std::process::Child>>`; `start_ollama` сохраняет ребёнка; `stop_ollama` и `RunEvent::Exit` делают `take()` + `kill()` только своего процесса. sysinfo остаётся только в `is_ollama_running` (детект чужого инстанса). Проверка: [трассировка] флаг `we_started_ollama` и сканирование по имени уходят из stop-пути полностью; sysinfo-API для kill по PID не нужен — Child::kill стандартный. Последствия: пользовательский Ollama больше не может быть убит приложением; если ребёнок умер сам — stop честно сообщит «не запущен».

### SOL-F-07 — allowlist хостов для ai_network_request
`AppState` + `RwLock<HashSet<String>>` разрешённых хостов (lowercase); статические: `api.github.com`, `generativelanguage.googleapis.com`; динамические: хосты из `customBaseUrl` и `ollamaUrl`, обновляются в `set_app_config` (команда уже `rename_all = "snake_case"`, добавляются параметры `custom_base_url`, `ollama_url`; JS-вызов в App.tsx передаёт их). В `ai_network_request`: `isahc::http::Uri::try_from(url)` → `host()` → разрешён, если `127.0.0.1 | localhost | ::1 | в списке`, иначе `Err("Host not allowed: …")`. Проверка: **[прототип] 7/7 кейсов** — включая регистр хоста, невалидный URL, запрет чужого хоста; покрытие всех 6 call-sites проверено grep: openaiCompatibleService (хост = customBaseUrl или ollamaUrl), ragService (ollamaUrl), githubService (api.github.com) — каждый хост либо статический, либо из настроек. Последствия: новые пресеты провайдеров работают без изменений кода (хост попадает через customBaseUrl); издержка — один парсинг URI на запрос (наносекунды).

### SOL-F-08 — замена localhost только в хосте
`url.replacen("://localhost", "://127.0.0.1", 1)` во всех 5 местах. Проверка: **[прототип] 4/4 кейса**, включая эмпирически подтверждённую поломку старого кода на `api.localhost-proxy.io`. Ограничение, задокументированное: UPPERCASE `LOCALHOST` не покрывается (реальные URL из пресетов и настроек — в нижнем регистре); при внесении можно добавить `to_lowercase()` хоста, если появится кейс.

### SOL-F-10 — удалить `tauriFetch.ts` и его реэкспорт из `packages/core/src/index.ts`
Проверка: [трассировка] grep — ноль вызовов вне barrel. Риск: ноль (git сохранит историю).

### SOL-F-11 — least privilege
Удалить: npm-зависимости `@tauri-apps/plugin-shell` (desktop) и `@tauri-apps/plugin-fs` (core + desktop), Rust-плагины `tauri_plugin_shell::init()` / `tauri_plugin_fs::init()`, capability-строки `shell:default` и `fs:default`. Остаётся: `dialog:default` (save-диалог используется), `window-state` (без JS-разрешений не нуждается). Проверка: [трассировка] grep — ноль TS-импортов обоих плагинов; plugin-dialog независим. Верификация при внесении: cargo build + smoke-запуск (окно, save-диалог, генерация).

### SOL-F-12 — логи без символов ключа
Три println (`lib.rs:82`, `728-731`) → «key present (len N)» / «key NOT FOUND (len N)». Проверка: grep — других мест печати ключа нет. Риск: ноль.

### SOL-F-13 — `.github` не прятать
`name.starts_with(".git")` → `name == ".git"` (каталог). Последствия: `.github/` и корневые `.gitignore/.gitattributes` попадут в скан — желаемое (это осмысленный контекст репозитория). Риск: чуть больше файлов — на сотни КБ не влияет (лимит 1МБ/файл остаётся).

### SOL-F-14 — ollama_fetch_models честная ошибка
`return Err(format!("Ollama models: HTTP {}", status))` вместо `Ok(vec![])`. Проверка: [трассировка] единственный потребитель — `handleTestLocalEngine`: Err → `isConnected=false` → честное «Connection failed» вместо пустого списка. Риск: ноль.

### SOL-F-15 — connect_timeout стартовым клиентам
`connect_timeout(Duration::from_secs(15))` в оба билдера (`lib.rs:733-741`). Проверка: [живое доказательство] тот же механизм работает в set_app_config-клиенте. Риск: ноль.

### SOL-F-16 — UTF-8-безопасный хинт ключа
`fn key_hint(k: &str) -> String` на `chars().take(4)` + хвост из 4 символов; заменить 3 места срезов (`lib.rs:705, 715, 729`). Проверка: **[прототип]** — кириллический «ключ», на котором старый код паникует, обрабатывается корректно.

### SOL-F-17 — рабочий lint desktop
`"lint": "tsc --noEmit"` в `apps/desktop/package.json`. Проверка: `npx tsc --noEmit` в apps/desktop проходит (запускалось в этой сессии многократно). Последствия: `npm run lint` начнёт проверять desktop — сейчас это 5-10 сек; единственный риск — если в web появятся типы, которых нет в desktop tsconfig (tsconfigs уже разошлись) — при внесении проверить оба.

### SOL-F-18 — константы моделей
`const DEFAULT_MODEL_FLASH: &str = "gemini-3-flash-preview";` + `DEFAULT_MODEL_PRO: &str = "gemini-3.1-pro-preview";` в lib.rs; обе функции используют. Риск: ноль.

### SOL-F-19 — решение: без изменений
`net_debug` — осознанный отладочный крейт вне сборки, задокументирован в AGENTS.md. Оставить как есть.

### SOL-F-20 — удалить мёртвую команду
Убрать `scan_local_repository` (fn + регистрацию) и поправить AGENTS.md: «выбор папки — webkitdirectory в WebView; нативный FS — только сохранение через dialog + save_text_file». Альтернатива (нативный пикер папок через plugin-dialog) — будущая фича, не сейчас. Проверка: [трассировка] ноль вызовов. Риск: ноль (git сохранит реализацию для будущей нативной фичи).

### Порядок внесения (когда будет одобрено)
1. F-01 + F-05 + F-08 (один файл lib.rs, механические) → 2. F-02 (App.tsx) → 3. F-06, F-07, F-12, F-14, F-15, F-16, F-18, F-20 (Rust, мелкие) → 4. F-10, F-11, F-13, F-17 (очистка) → 5. Полная верификация: cargo check + tsc ×2 + contract-check + сборка + smoke (окно, save-диалог, NVIDIA Fetch Models, локальная генерация).

## G3 (manual gate): верификация HIGH-находок

- F-01: процитировано точно — в `lib.rs:276-278` между `send_async` и парсингом JSON нет проверки статуса (перечитано в этой сессии; соседний запрос info на `lib.rs:250-252` статус проверяет — контраст подтверждает, что пропуск не опечатка пересказа).
- F-02: `signal` создаётся и не потребляется — grep по App.tsx: единственное вхождение создания `App.tsx:883`, `delay(` — ноль вызовов; `ollamaService.ts:48-55` — аргументов отмены нет; эффект сохранения истории висит на `prompt` и сработает после «Cancel». Подтверждено по исходникам.

## Внесение решений (2026-10-12)

Все 19 находок закрыты. Проверка после внесения:
- `contract-check` → `INVENTORY OK` (15 команд / 17 вызовов / 0 расхождений, включая новые `custom_base_url`/`ollama_url`);
- `fix-check` → `FIXES OK` (18/18 assertion'ов по каждому фиксу);
- `cargo check` — чисто; `tsc --noEmit` web + desktop — чисто (desktop lint теперь настоящий);
- `npm run tauri build` — MSI/NSIS собраны;
- smoke живого приложения: запуск/закрытие, `[Init] … present (len: 39)` (F-12 в действии), `.window-state.json` сохранён.

Примечания: сетевой запрос при Cancel физически продолжает гореть (UI/история честны — см. SOL-F-02, уровень 2 — future work); allowlist пополняется при каждом изменении настроек провайдера — старые хосты остаются разрешёнными (осознанный компромисс).

## Раунд ручных тестов (Errors.txt, 2026-10-12 — все исправлены)

| ID | Статус | Находка и решение |
|----|--------|-------------------|
| F-21 | ИСПРАВЛЕНО | Start/Stop Ollama и Test Connection спрятаны глубоко в опциях. Решение: компактный чип в верхней панели (строка Instructions) — точка-статус + кнопка Start/Stop; клик по чипу перепроверяет. Проверка коннекта теперь автоматическая: на старте, после Start/Stop и при смене engine/URL (дебаунс 0.8с) — кнопка Test Connection на desktop удалена (на web осталась: там CORS делает автотест ненадёжным). Стартовый автотест подтверждён smoke-логом живого приложения. |
| F-22 | ИСПРАВЛЕНО | Прогресс не виден: у плавающей плашки ветка isTruncated имела приоритет над loading — на большом репозитории предупреждение навсегда закрывало весь прогресс (корень жалоб №2+№3). Решение: зарезервированная статус-строка (h-7, без absolute — ничего не перекрывает): при генерации — спиннер + шаг + таймер mm:ss + Cancel; summarize-циклы теперь с счётчиком `i/N` (прогресс RAG уже шёл из performRAG: "Embedding chunks (i/N)"); isTruncated стал временным уведомлением (8с) вместо вечного состояния. |
| F-23 | ИСПРАВЛЕНО | «Gemini API key is missing» при прописанном env-ключе: эффект на монтировании отправлял `gemini_key: ""` (пустое поле UI), и Rust затирал env-ключ пустой строкой. Решение: JS шлёт `gemini_key: geminiApiKey \|\| null` — пустое поле = None = «не трогать» (Rust уже так семантически устроен, `if let Some`). Побочно: очистить UI-ключ можно Reset all settings. |
| F-24 | ИСПРАВЛЕНО | Ключ Gemini лежал в Desktop Settings рядом с прокси. Решение: поле (с глазком и индикатором) переехало в AI Provider — показывается при выборе провайдера «Gemini (default)», симметрично полям Custom; в Desktop Settings остался только прокси. Добавлен чип «Active key: env:AIza…x9» (get_gemini_key_source) — сразу видно, чей ключ активен, что напрямую закрывает путаницу из F-23. |

Верификация: tsc web/desktop чисто; MSI/NSIS пересобраны; smoke живого desktop-приложения: env-ключ в логе, стартовый автотест Ollama сработал, корректное закрытие.

## Раунд ручных тестов 2 (Errors.txt, 2026-10-12 — оба исправлены)

| ID | Статус | Находка и решение |
|----|--------|-------------------|
| F-25 | ИСПРАВЛЕНО | 429 «quota exceeded, limit: 0, model: gemini-3.1-pro» — у модели 3.1-pro-preview нулевая квота free-tier, финальная генерация по умолчанию обречена. Решение: живые пробы ListModels + generateContent по ключу: gemini-3.1-pro-preview → 429 (лимит 0), gemini-3-flash-preview → 200 (стабильно), **gemini-3.6/3.7/3.8-flash → 200** (интермиттентный 503 «high demand» — модель только выложена, перегрузка временная; подтверждено повторами). ID-написание подтверждено листингом API: `gemini-3.8-flash`. Все четыре зашитых имени переведены на gemini-3.8-flash (Rust-константы GEMINI_QUERY_MODEL/GEMINI_FINAL_MODEL + три хардкода geminiService.ts). |
| F-26 | ИСПРАВЛЕНО | «Не выбран ни один файл» рядом с кнопкой выбора файлов — это СОБСТВЕННАЯ подпись нативного виджета Chromium внутри input, она не отражала состояние React (данные при этом передавались — успешная генерация «Target Repository: Local Folder» из того же теста это доказывает). Решение: нативный input спрятан (hidden), вместо него кнопка «Choose folder» + наша строка статуса «N files · <корень>» / «no folder selected» — состояние всегда честное (в т.ч. осознанное сбрасывание выбора после генерации на репозиториях >1000 файлов для освобождения памяти). |

Верификация: tsc web/desktop чисто; cargo check чисто; MSI/NSIS пересобраны; smoke живого приложения — запуск, автотест Ollama, корректное закрытие.

## Раунд 3 (2026-10-12, по запросу пользователя — оба исправлены)

| ID | Статус | Находка и решение |
|----|--------|-------------------|
| F-27 | ИСПРАВЛЕНО | Хардкод модели Gemini. Решение: выбор модели в UI — в блоке Gemini (AI Provider) появился пикер, список подгружается из ListModels по активному ключу (desktop — новая команда `gemini_list_models` с фильтром generateContent-способных текстовых моделей; web — прямой fetch по ключу из поля); без списка — поле ввода с дефолтом. Выбор проходит сквозным параметром `geminiModel` через aiAdapter → generateSystemPrompt/rewriteQueryWithGemini → Rust-команды (model), сохраняется в настройках. Дефолт — gemini-3.8-flash (константы DEFAULT_GEMINI_MODEL в TS и GEMINI_QUERY_MODEL/GEMINI_FINAL_MODEL в Rust, синхронизированы комментарием). |
| F-28 | ИСПРАВЛЕНО | Отсутствие retry при transient-ошибках заставляло перезапускать всю генерацию. Решение: автоматический retry (3 попытки, пауза 2с → 8с) на 500/502/503/504 — в Rust (gemini_generate_with_retry для call_gemini_secure и call_gemini_advanced) и в JS для web-ветки (@google/genai обёрнут в withTransientRetry); 429 НЕ ретраится — это окончательная квота, а не перегрузка. Retry происходит внутри одного запроса — RAG/суммаризация не гоняются заново. |

Верификация: tsc web/desktop чисто; cargo check чисто; contract-check INVENTORY OK (15 команд / 19 вызовов); MSI/NSIS пересобраны; smoke живого приложения прошёл.
