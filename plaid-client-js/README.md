# @larc-iu/plaid-client

The JavaScript client for the [Plaid](https://larc-iu.github.io/plaid/) annotation API.
It has no dependencies and runs in browsers and in Node.

## From npm

```sh
npm install @larc-iu/plaid-client@alpha
```

```js
import { PlaidClient } from "@larc-iu/plaid-client";

const client = await PlaidClient.login("http://localhost:8080", "user@example.com", "password");
console.log(await client.projects.list());
```

## From a Plaid server

Every Plaid server serves the client that matches its own version at `/client/plaid-client.js`, with its type declarations at `/client/plaid-client.d.ts`.
A page served by Plaid, for example from the folder set as `static_resources_path` in its `config.toml`, can import it without bundling a copy:

```html
<script type="module">
  import { PlaidClient } from "/client/plaid-client.js";
  const client = await PlaidClient.login(location.origin, "user@example.com", "password");
  console.log(await client.projects.list());
</script>
```

## Documentation

- [Manual](https://larc-iu.github.io/plaid/manual.html), which covers the API and its concepts.
- [API reference](https://larc-iu.github.io/plaid/api-js.html) for this client.
