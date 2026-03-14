import sys

def find_unclosed_quotes(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.split('\n')
    
    in_multiline_comment = False
    
    # Track which quote is open
    open_quote = None # None, '"', "'", '`'
    open_pos = (0, 0) # line, col
    
    for line_num, line in enumerate(lines, 1):
        i = 0
        while i < len(line):
            char = line[i]
            
            if not open_quote and not in_multiline_comment:
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
                
            if open_quote:
                if char == '\\':
                    i += 2
                    continue
                if char == open_quote:
                    # Closing the quote
                    if open_quote == '`' or True: # all quotes behave similar for this check
                        open_quote = None
                i += 1
                continue
            else:
                if char in ('"', "'", '`'):
                    open_quote = char
                    open_pos = (line_num, i + 1)
            i += 1
        
        # At end of line, if it's not a backtick, it usually must close (unless it's a multi-line string in some languages, but in TS/JS only backticks are multi-line)
        if open_quote and open_quote != '`':
            print(f"Unclosed {open_quote} at line {open_pos[0]}, column {open_pos[1]}")
            open_quote = None # Reset for next line to find more

    if open_quote == '`':
        print(f"Unclosed ` starting at line {open_pos[0]}, column {open_pos[1]}")

if __name__ == "__main__":
    find_unclosed_quotes(sys.argv[1])
