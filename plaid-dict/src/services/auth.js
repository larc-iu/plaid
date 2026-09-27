// The session is plaid-ui's, as in the other apps: the same localStorage keys,
// so a reader signed in to /igt/ is signed in here, and the same answer to a
// 401. A refused save keeps the page and what is typed on it (the Setup form),
// with a notice offering sign-in in a new tab. main.jsx names the sign-in route.
export { authService } from '@ui/services/auth.js';
