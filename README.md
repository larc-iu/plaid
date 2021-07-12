# What's this?

An app for annotating linguistic data that's still under construction. It's built using [Clojure](https://clojure.org/)([Script](https://clojurescript.org/)), [Material-UI](https://material-ui.com/), [Fulcro](https://fulcro.fulcrologic.com/), and [Crux](https://opencrux.com/main/index.html). Check back soon 🚧

# How do I run this? 
There's not much to look at presently, but if you really want to:

## Command Line
```bash
# install dependencies
$ yarn
# start compiling CLJS, and start a server repl--note you'll have to type `(start)`
$ yarn start
clojure -A:dev
Clojure 1.10.1
user=> (start)
# navigate to localhost:8085, and see package.json for more
```

## IntelliJ + Cursive
On the terminal:
```bash
yarn client/main
```

Clojure Server Profile:

1. Make a new profile based on "Clojure REPL > Local"
2. Select "Run with Deps"
3. Put `dev` in Aliases
4. Run and write (start)
5. See `src/dev/user.clj` for development tools.

ClojureScript Client Profile:

1. Make a new profile based on "Clojure REPL > Remote"
2. Connection type: `nREPL` 
3. Connection details: "Use port from nREPL file" 
4. Project: `glam`
5. Make sure you're entered `(start)` in the server. 
6. Navigate to `localhost:8085`
7. Run your client profile and enter:
```clojure
(require '[shadow.cljs.devtools.api :as shadow])
(shadow/repl :main)
```
8. Write `(js/console.log "hi")` and ensure that it was printed out to the console in your browser session

## Release build
```bash
clojure -X:uberjar
# to run:
java -jar target/server.jar
```

## Updating dependencies

```bash
# clojure dependencies
clojure -M:outdated
# js dependencies
yarn outdated
```


# Architectural Overview
- main code is in `src/main`
- db-layer files are in `glam.crux`. `glam.crux.easy` contains some wrapper functions around `crux.api`, and every other 
  file pertains to a single entity type, e.g. `user`, `project`, etc. All functions in this layer are concerned solely 
  with doing things with the database and will assume that its callers will take care of orthogonal concerns such as
  authorization, data integrity (e.g. enforcing uniqueness constraints)
  - naming conventions: 
    - a function suffixed with a single `*` returns a vector which describes a single crux operation and does NOT take
      `node` as a first arg
    - a function suffixed with a double `**` returns a vector which describes a crux transaction (which has operations)
      and DOES take `node` as a first arg.
- model code is under `glam.models`, again one file per entity type. This is where validation code, Pathom resolvers 
  and mutations, and Fulcro mutations go. This is the layer that mediates the database and the UI. This is where 
  business logic goes, and it is the responsibility of the resolvers and mutations to cover auth, integrity, etc.
- ui code goes under `glam.ui`