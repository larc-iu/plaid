> [!NOTE]
> If you are looking for Glam, please see [the `glam` branch](https://github.com/larc-iu/plaid/tree/glam) of this repository.

# Plaid

# Development

* `clojure -X:dev`: start development server by typing `(start)`. See <http://localhost:8085> 
* `clojure -M:test`: run tests
* `clojure -M:outdated`: find outdated dependencies
* `clojure -X:uberjar`: compile to a single `.jar` for production
* `clojure -M:client-gen custom-api.json CustomClient.js`: generate JS API client from OpenAPI spec.

## OpenAPI Support
* See playground at <http://localhost:8085/api/v1/docs/index.html#/>
* See JSON at <http://localhost:8085/api/v1/openapi.json>

## XTDB Inspector
Make sure that `XTDB_INSPECTOR_URI_PREFIX` is set to `/_inspector` if you want to use the web UI to inspect the database.
```
export XTDB_INSPECTOR_URI_PREFIX=/_inspector
```
It will be visible at <http://localhost:8085/_inspector/attr>.
