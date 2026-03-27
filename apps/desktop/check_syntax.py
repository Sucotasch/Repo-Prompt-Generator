import sys

def check_balance(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    stack = []
    lines = content.split('\n')
    
    in_multiline_comment = False
    in_string = False
    string_char = ''
    
    for i, line in enumerate(lines):
        ln = i + 1
        j = 0
        while j < len(line):
            char = line[j]
            
            if not in_string and not in_multiline_comment:
                if line[j:j+2] == '//':
                    break # Skip rest of line
                if line[j:j+2] == '/*':
                    in_multiline_comment = True
                    j += 2
                    continue
            
            if in_multiline_comment:
                if line[j:j+2] == '*/':
                    in_multiline_comment = False
                    j += 2
                    continue
                j += 1
                continue
                
            if char in ['"', "'", '`']:
                if not in_string:
                    in_string = True
                    string_char = char
                elif string_char == char:
                    # Check for escape
                    esc_count = 0
                    k = j - 1
                    while k >= 0 and line[k] == '\\':
                        esc_count += 1
                        k -= 1
                    if esc_count % 2 == 0:
                        in_string = False
            
            if not in_string:
                if char in ['(', '{', '[']:
                    stack.append((char, ln, j+1))
                elif char in [')', '}', ']']:
                    if not stack:
                        print(f"Extra closing '{char}' at line {ln}, column {j+1}")
                    else:
                        opening, open_ln, open_col = stack.pop()
                        match = {')': '(', '}': '{', ']': '['}
                        if opening != match[char]:
                            print(f"Mismatched closing '{char}' at line {ln}, column {j+1}. Expected closing for '{opening}' from line {open_ln}, column {open_col}")
            j += 1
            
    if stack:
        for char, ln, col in stack:
            print(f"Unclosed '{char}' from line {ln}, column {col}")

if __name__ == "__main__":
    check_balance(r"d:\Arx\Software Downloads\_Images_EDIT-pack\Repo-Prompt-Generator\src\App.tsx")
