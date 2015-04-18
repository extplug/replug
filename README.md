# non-lethal plug.dj reverse engineering

A messy script that spews as-sexy-as-computerly-possible versions of plug.dj modules into a directory.

Minimal customizability, not enough automation. Awesome. :shipit:

Slap ReAnna if it doesn't work. (Metaphorically.)

## prerequisites

1. `git clone https://github.com/pluglynn/replug`
1. `cd replug`
1. `npm install`

---

## actually doing things

1. Log in to plug.dj (lol)
1. Run the `getMapping.js` file in your browser console
1. A `mapping.json` file will be downloaded. This file contains the mapping from plug.dj's obfuscated module names, to `plug-modules`'s deobfuscated module names. `replug` will use it to determine the file names for modules.
1. Run the index.js file in this repo: `node index.js <mapping file>`, eg. `node index.js mapping.json`
1. Wait
1. Check `out/app` which will now contain a ton of files. Actual files are in a directory with a semi-random name, which is the actual plug.dj module name. Another directory `out/app/plug/` contains symlinks with nicer names where possible.

Remember to delete the `out/app` directory before every rerun.
