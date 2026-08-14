import sys

# Fix AccPanel
f = "src/ui/tools/acc/AccPanel.tsx"
with open(f, 'r') as file:
    content = file.read()
content = content.replace("var(--text-secondary)", "var(--ink-subtle)")
with open(f, 'w') as file:
    file.write(content)

