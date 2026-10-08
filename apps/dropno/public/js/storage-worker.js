const files = new Map();
let chain = Promise.resolve();
self.onmessage = ({ data }) => {
  chain = chain.then(async () => {
    try {
      const { request, type, directory, id, bytes, offset } = data;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(directory, { create: true });
      if (type === 'open') {
        const file = await dir.getFileHandle(id, { create: true });
        const handle = await file.createSyncAccessHandle();
        handle.truncate(0); handle.flush(); files.set(id, handle);
      } else if (type === 'write') {
        const handle = files.get(id);
        if (!handle) throw new Error('Temporary file is no longer open');
        let written = 0; const view = new Uint8Array(bytes);
        while (written < view.length) {
          const count = handle.write(view.subarray(written), { at: offset + written });
          if (!count) throw new Error('Could not write received bytes');
          written += count;
        }
        handle.flush();
      } else if (type === 'finish') {
        const handle = files.get(id); handle.flush(); handle.close(); files.delete(id);
      } else if (type === 'remove') {
        files.get(id)?.close(); files.delete(id);
        await dir.removeEntry(id).catch(error => { if (error.name !== 'NotFoundError') throw error; });
      } else if (type === 'probe') {
        const name = `probe-${id}`;
        const file = await dir.getFileHandle(name, { create: true });
        const handle = await file.createSyncAccessHandle(); handle.close(); await dir.removeEntry(name);
      }
      self.postMessage({ request });
    } catch (error) { self.postMessage({ request: data.request, error: error.message }); }
  });
};
