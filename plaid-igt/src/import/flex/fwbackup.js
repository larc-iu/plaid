// .fwbackup handling — a FieldWorks backup is a zip whose payload is a single
// `<project name>.fwdata` XML file (plus settings/writing-system files we
// don't need). Works in both the browser and Node (fflate + TextDecoder).

import { unzipSync } from 'fflate';

/**
 * Extract the .fwdata XML from a .fwbackup zip.
 * @param {Uint8Array} bytes — raw zip contents
 * @returns {{name: string, xml: string}} — project name (from the fwdata
 *   filename) and the decoded XML string
 */
export function readFwbackup(bytes) {
  let fwdataName = null;
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (f.name.toLowerCase().endsWith('.fwdata') && !f.name.includes('/')) {
        fwdataName = f.name;
        return true;
      }
      return false;
    },
  });
  if (!fwdataName) {
    throw new Error('Not a FieldWorks backup: no .fwdata file found in the archive');
  }
  return {
    name: fwdataName.replace(/\.fwdata$/i, ''),
    xml: new TextDecoder('utf-8').decode(files[fwdataName]),
  };
}
