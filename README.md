# non-lethal plug.dj reverse engineering

A messy script that spews as-sexy-as-computerly-possible versions of plug.dj
modules into a directory.

Minimal customizability, not enough automation. Awesome. :shipit:

Slap ReAnna if it doesn't work. (Metaphorically.)

## installing

For a globally installed CLI:

1. `npm i -g replug`

Or for source:

1. `git clone https://github.com/ExtPlug/replug.git`
1. `cd replug`
1. `npm install`

## actually doing things

    Options:

      -h, --help                 output usage information
      -V, --version              output the version number
      -m, --mapping [file]       File containing the mapping JSON
      -o, --out [dir]            Output directory [out/]
      --save-source              Copy the source javascript to the output directory
      --save-mapping             Copy the mapping file to the output directory
      -a, --auto                 Generate the mapping file automatically

### easy way

**Plain:**

Dumps output in `out/`, and doesn't store the original JavaScript source or the
mapping file.

```
replug --auto
```

**Full:**

Outputs in `output-directory/`, and stores the original JavaScript source in
`source.js`, and the mapping file as `mapping.json`.

```
replug --auto --out output-directory \
  --save-source --save-mapping
```

The `--auto` flag runs `plug-modules` automatically to remap plug.dj's
obfuscated module names to readable module names. It does that by essentially
fully loading and booting plug.dj, much like the below old-fashioned way but
headless.

### harder, partly browser-based, but still pretty solid way:

1. Log in to plug.dj (lol)
1. Run the `getMapping.js` file in your browser console
1. A `mapping.json` file will be downloaded. This file contains the mapping from
   plug.dj's obfuscated module names, to `plug-modules`'s deobfuscated module
   names. `replug` will use it to determine the file names for modules.
1. Run the index.js file in this repo: `node index.js --mapping <file>`, eg.
   `node index.js --mapping mapping.json`
1. Wait
1. Check `out/app` which will now contain a ton of files. Actual files are in a
directory with a semi-random name, which is the actual plug.dj module name.
Another directory `$OUT_DIR/plug/` contains symlinks with nicer names where
possible.

Remember to delete the `out/app` directory before every rerun.
