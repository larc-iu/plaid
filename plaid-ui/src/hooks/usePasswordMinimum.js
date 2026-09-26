import { useEffect, useState } from 'react';
import { authService } from '../services/auth.js';

// The shortest password the server accepts on any path (an account an admin
// creates, a password change, an invite or reset link). Core holds the one
// number, `plaid.sql.user/min-password-length`, and publishes it on GET /info
// as `limits.passwordMinLength`. Every password field in plaid-ui reads it
// here rather than keeping a copy.
//
// Null until the server answers, and null for a server that does not publish
// it. A form then asks nothing of the length and shows the server's refusal
// instead, which names the number.

/** The server's password minimum, or null while it is not known. */
export const usePasswordMinimum = () => {
  const [minimum, setMinimum] = useState(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => authService.serverLimits())
      .then((limits) => {
        const n = limits?.passwordMinLength;
        if (alive && Number.isInteger(n) && n > 0) setMinimum(n);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return minimum;
};

/** The refusal for a password under `minimum` characters, or null. */
export const passwordTooShort = (password, minimum) =>
  minimum && password.length < minimum ? `Password must be at least ${minimum} characters` : null;
