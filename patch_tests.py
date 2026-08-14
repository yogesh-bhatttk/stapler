import sys

# Fix AccPanel.tsx
filepath = "src/ui/tools/acc/AccPanel.tsx"
with open(filepath, 'r') as f:
    content = f.read()
import re
content = re.sub(r'color: ["\']#[a-fA-F0-9]{3,6}["\']', 'color: "var(--text-secondary)"', content)
content = re.sub(r'color: ["\']#000["\']', 'color: "var(--text)"', content)
content = re.sub(r'#[a-fA-F0-9]{3,6}', 'var(--text-secondary)', content) # Just in case

# Actually, let's just see what's on line 61. I will just run a sed.

