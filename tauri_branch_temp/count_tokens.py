import sys

def count_tokens(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    counts = {
        '(': 0, ')': 0,
        '{': 0, '}': 0,
        '[': 0, ']': 0,
        '"': 0, "'": 0,
        '`': 0
    }
    
    in_multiline_comment = False
    in_single_line_comment = False
    it = iter(enumerate(content))
    for i, char in it:
        if in_single_line_comment:
            if char == '\n':
                in_single_line_comment = False
            continue
        if in_multiline_comment:
            if char == '*' and i + 1 < len(content) and content[i+1] == '/':
                in_multiline_comment = False
                next(it)
            continue
            
        if char == '/' and i + 1 < len(content):
            if content[i+1] == '/':
                in_single_line_comment = True
                next(it)
                continue
            if content[i+1] == '*':
                in_multiline_comment = True
                next(it)
                continue
                
        if char in counts:
            counts[char] += 1
            
    for char, count in counts.items():
        print(f"{char}: {count}")

count_tokens(sys.argv[1])
