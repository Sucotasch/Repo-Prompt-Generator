import sys

def find_unbalanced_paren(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    stack = []
    lines = content.split('\n')
    
    in_multiline_comment = False
    in_string = False
    string_char = ''
    
    for line_num, line in enumerate(lines, 1):
        i = 0
        while i < len(line):
            char = line[i]
            
            if not in_string and not in_multiline_comment:
                if char == '/' and i + 1 < len(line) and line[i+1] == '/':
                    break # Single line comment
                if char == '/' and i + 1 < len(line) and line[i+1] == '*':
                    in_multiline_comment = True
                    i += 2
                    continue
            
            if in_multiline_comment:
                if char == '*' and i + 1 < len(line) and line[i+1] == '/':
                    in_multiline_comment = False
                    i += 2
                else:
                    i += 1
                continue
                
            if in_string:
                if char == '\\':
                    i += 2
                    continue
                if char == string_char:
                    in_string = False
                i += 1
                continue
            else:
                if char in ('"', "'", '`'):
                    in_string = True
                    string_char = char
                    i += 1
                    continue
            
            if char == '(':
                stack.append((line_num, i + 1))
            elif char == ')':
                if not stack:
                    print(f"Extra ')' at line {line_num}, column {i+1}")
                else:
                    stack.pop()
            i += 1

    if stack:
        print(f"Unclosed '(' found at:")
        for line_num, col in stack:
            print(f"  Line {line_num}, Column {col}")
    else:
        print("Parentheses are balanced (within limits of this script).")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        find_unbalanced_paren(sys.argv[1])
    else:
        print("Usage: python script.py <file_path>")
