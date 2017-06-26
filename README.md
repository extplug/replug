# non-lethal plug.dj reverse engineering

A messy script that spews as-readable-as-computerly-possible versions of plug.dj
modules into a directory.

## installing

For a globally installed CLI:

1. `npm i -g replug`

Or for source:

1. `git clone https://github.com/ExtPlug/replug.git`
1. `cd replug`
1. `npm install`

## actually doing things

    Options:

      -h, --help            output usage information
      -V, --version         output the version number
      -m, --mapping [file]  File containing the mapping JSON (optional, it's auto-generated if no file is given)
      -o, --out [dir]       Output directory [out/]
      -v, --verbose         Use verbose output instead of bullet list

### examples

Dump output in `out/`:

```
replug
```

Output in `output-directory/`:

```
replug --out output-directory
```

## Licence

[MIT](./LICENSE)
