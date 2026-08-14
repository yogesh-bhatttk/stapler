import sys

filepath = "src/platform/file-system.ts"
with open(filepath, 'r') as f:
    content = f.read()

content = content.replace("} catch (err) {\\n      // Ignore if queryPermission fails", "} catch {\\n      // Ignore if queryPermission fails")
content = content.replace("} catch (err) {\\n    // Permission denied or clipboard empty", "} catch {\\n    // Permission denied or clipboard empty")

with open(filepath, 'w') as f:
    f.write(content)
