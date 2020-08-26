# What's this?

An app for annotating linguistic data that's still under construction. It's built using [Clojure](https://clojure.org/)([Script](https://clojurescript.org/)), [Material-UI](https://material-ui.com/), [Fulcro](https://fulcro.fulcrologic.com/), and [Crux](https://opencrux.com/main/index.html). Check back soon 🚧

# How do I run this? 
There's not much to look at presently, but if you really want to:

```bash
# in one session
$ make fe 
# in another session
$ make start-dev-server
clojure -A:dev
Clojure 1.10.1
user=> (start)
# navigate to localhost:8085
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