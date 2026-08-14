import sys

def modify_file(filepath, replacements):
    with open(filepath, 'r') as f:
        content = f.read()
    
    for old, new in replacements:
        if old not in content:
            print(f"Warning: could not find {old} in {filepath}")
        content = content.replace(old, new)
        
    with open(filepath, 'w') as f:
        f.write(content)

base = "/home/yogeshbhatt/.gemini/antigravity/brain/e3373477-5158-4aab-97c6-a392d4f11598/.system_generated/worktrees/subagent-Feature-Developer-for-CNV-07-self-dd92d813/"

modify_file(base + "src/platform/index.ts", [
    ("  reopenHandle(id: string): Promise<OpenedFile | null>;\n  revokeHandle(id: string): Promise<void>;\n}", "  reopenHandle(id: string): Promise<OpenedFile | null>;\n  revokeHandle(id: string): Promise<void>;\n\n  /** Reads an image from the OS clipboard, or null if empty/refused. */\n  readClipboardImage(): Promise<File | null>;\n}")
])

fs_old = """import type { OpenOptions, OpenedFile, OutputDirectory, RecentEntry } from './index';
import { deleteHandle, listHandles, readHandle, writeHandle } from '../core/db';"""
fs_new = """import type { OpenOptions, OpenedFile, OutputDirectory, RecentEntry } from './index';
import { deleteHandle, listHandles, readHandle, writeHandle } from '../core/db';

export async function readClipboardImage(): Promise<File | null> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          const extension = type.split('/')[1] || 'png';
          return new File([blob], `Pasted Image.${extension}`, { type });
        }
      }
    }
  } catch (err) {
    // Permission denied or clipboard empty
  }
  return null;
}"""
modify_file(base + "src/platform/file-system.ts", [(fs_old, fs_new)])

web_old1 = """  revokePersisted,
  saveOverHandle,
  saveViaDownload,
  saveViaPicker
} from './file-system';"""
web_new1 = """  revokePersisted,
  saveOverHandle,
  saveViaDownload,
  saveViaPicker,
  readClipboardImage
} from './file-system';"""
web_old2 = """  restoreHandles: async () => (hasFileSystemAccess() ? listRecent() : []),
  reopenHandle: async id => (hasFileSystemAccess() ? reopenPersisted(id) : null),
  revokeHandle: revokePersisted
};"""
web_new2 = """  restoreHandles: async () => (hasFileSystemAccess() ? listRecent() : []),
  reopenHandle: async id => (hasFileSystemAccess() ? reopenPersisted(id) : null),
  revokeHandle: revokePersisted,
  readClipboardImage
};"""
modify_file(base + "src/platform/web.ts", [(web_old1, web_new1), (web_old2, web_new2)])

ext_old1 = """  revokePersisted,
  saveOverHandle,
  saveViaDownload,
  saveViaPicker
} from './file-system';"""
ext_new1 = """  revokePersisted,
  saveOverHandle,
  saveViaDownload,
  saveViaPicker,
  readClipboardImage
} from './file-system';"""
ext_old2 = """  restoreHandles: listRecent,
  reopenHandle: reopenPersisted,
  revokeHandle: revokePersisted
};"""
ext_new2 = """  restoreHandles: listRecent,
  reopenHandle: reopenPersisted,
  revokeHandle: revokePersisted,
  readClipboardImage
};"""
modify_file(base + "src/platform/extension.ts", [(ext_old1, ext_new1), (ext_old2, ext_new2)])

app_shell_old1 = """import { activeDoc, selectAllPages } from '../../core/store';
import { readSetting, writeSetting } from '../../core/db';"""
app_shell_new1 = """import { activeDoc, selectAllPages, insertPages, selectedPageKeys } from '../../core/store';
import { importFiles } from '../../core/import';
import { platform } from '../../platform/current';
import { notify } from '../../core/notify';
import { readSetting, writeSetting } from '../../core/db';"""

app_shell_old2 = """    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);"""
app_shell_new2 = """    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onPaste = async (event: ClipboardEvent) => {
      if (isTypingTarget(event.target)) return;
      
      const doc = activeDoc.value;
      if (!doc) return;

      const file = await platform.readClipboardImage();
      if (!file) {
        notify('warning', 'No image found on the clipboard.');
        return;
      }

      const { imported, failures } = await importFiles([file], undefined, undefined);
      if (failures.length > 0) {
        notify('error', failures[0].message);
        return;
      }

      if (imported.length > 0) {
        let at = doc.pages.length;
        if (selectedPageKeys.value.size > 0) {
          const indices = Array.from(selectedPageKeys.value).map(k => doc.pages.findIndex(p => p.key === k)).filter(i => i >= 0);
          if (indices.length > 0) {
            at = Math.max(...indices) + 1;
          }
        }
        insertPages(doc.id, imported[0].pages, at);
      }
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);"""
modify_file(base + "src/ui/shell/AppShell.tsx", [(app_shell_old1, app_shell_new1), (app_shell_old2, app_shell_new2)])

