export function safeJsonParse<T>(text: string, fallback: T): T {
  if (!text) return fallback;
  const cleanText = text.trim();
  try {
    return JSON.parse(cleanText) as T;
  } catch (e) {
    console.warn("JSON parse failed, attempting to recover from Markdown wrapping...", e);
    // Try to extract JSON from markdown code blocks
    const jsonMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim()) as T;
      } catch (_) {}
    }
    // Try to extract raw JSON object mapped by curly braces
    const objectMatch = cleanText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]) as T;
      } catch (_) {}
    }
    return fallback;
  }
}
