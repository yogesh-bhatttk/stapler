import sys

filepath = "src/platform/file-system.ts"
with open(filepath, 'r') as f:
    content = f.read()

content = content.replace("} catch {", "} catch (err) {")

old_str = """      }
    }
  } catch (err) {
    // Permission denied or clipboard empty
  }
  return null;
}"""
new_str = """      }
    }
  } catch {
    // Permission denied or clipboard empty
  }
  return null;
}"""

content = content.replace(old_str, new_str)

with open(filepath, 'w') as f:
    f.write(content)

