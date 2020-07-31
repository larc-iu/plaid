# Prerequisites

This template utilizes GNU Make 4.x. You'll need to install it first 
before executing `make`.

This template uses `yarn` to handle npm dependencies.

# Start dev

## Shadow cljs tasks

In one terminal:

```bash
make
```
this runs `yarn` and starts the shadow-cljs server.

Wait for this to complete, then:

In another terminal run:
```bash
make fe
```
This starts the shadow cljs watches.

Alternatively you can start the build watches via the shadow-cljs interface in the browser.

Please see the `shadow-cljs.edn` file for ports used for development builds.

If any of those ports are used already shadow-cljs will try different ports so please see the console output 
by shadow-cljs.

When the main build is complete, start the backend server either in an editor or at the command line.

The clj server reads the manifest file produced by shadow-cljs so the build must complete before you start the server.

## Editor setup

In your editor:
add 2 repls:

### frontend repl:

nREPL remote:

  localhost:$port
  
The $port defaults to 9000 but may be different if 9000 is already in use.

Using this repl you connect to the various clojurescript builds using `(shadow/repl :build-id)`

### backend repl:

nREPL local

alias: dev,test

start backend repl, then:

```clojure
(start) ;; (user/start)
```
This uses mount to start web server.

_note_ you do not need to specify any JVM parameters.

## Clojure webserver.

The clojure webserver listens on port 8085 by default - this is specified in `src/main/config/defaults.edn`

http://localhost:8085

# Production server build

All builds are handled by tasks in the Makefile.

```bash
make be-release

# Start the server with:
PORT=8080 make start-prod-server
```


## Devcards
Devcards are available at:

http://127.0.0.1:4001

