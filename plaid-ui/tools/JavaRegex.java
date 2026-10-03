// The server's regex engine (java.util.regex), for the clients' pattern
// translators (plaid-ui src/domain/javaRegex.js, plaid-agent
// core/java_regex.py) and their tests. Run with
// `java plaid-ui/tools/JavaRegex.java oracle` or `... scripts`.
//
// oracle: reads lines `<pattern hex>\t<subject hex>` (UTF-8 as hex) and
// prints, per line, 1 when the pattern finds a match in the subject, 0 when
// not, E when the pattern does not compile. The same call the server's REGEXP
// function makes (plaid.query.clauses/compile-regex): Pattern.compile with
// UNICODE_CHARACTER_CLASS, so \w, \d, \s and \b read every script, then find.
//
// scripts: prints every Unicode script this Java knows (but Unknown), one per
// line, as `<name>\t<hex of its first code point>`, for the translators'
// script table.
//
// The case-fold table the translators use comes from tools/caseFolds.mjs.

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

public class JavaRegex {
  public static void main(String[] args) throws Exception {
    if (args.length >= 1 && args[0].equals("oracle")) {
      oracle();
    } else if (args.length >= 1 && args[0].equals("scripts")) {
      scripts();
    } else {
      System.err.println("usage: JavaRegex oracle|scripts");
      System.exit(2);
    }
  }

  static void oracle() throws Exception {
    BufferedReader in =
        new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintWriter out = new PrintWriter(System.out);
    String last = null;
    Pattern compiled = null;
    boolean bad = false;
    String line;
    while ((line = in.readLine()) != null) {
      int tab = line.indexOf('\t');
      String pattern = unhex(line.substring(0, tab));
      String subject = unhex(line.substring(tab + 1));
      if (!pattern.equals(last)) {
        last = pattern;
        try {
          compiled = Pattern.compile(pattern, Pattern.UNICODE_CHARACTER_CLASS);
          bad = false;
        } catch (PatternSyntaxException e) {
          bad = true;
        }
      }
      out.println(bad ? "E" : compiled.matcher(subject).find() ? "1" : "0");
    }
    out.flush();
  }

  static void scripts() {
    java.util.Map<Character.UnicodeScript, Integer> first = new java.util.EnumMap<>(Character.UnicodeScript.class);
    for (int cp = Character.MAX_CODE_POINT; cp >= 0; cp--) first.put(Character.UnicodeScript.of(cp), cp);
    for (Character.UnicodeScript s : Character.UnicodeScript.values())
      if (s != Character.UnicodeScript.UNKNOWN)
        System.out.println(s.name() + "\t" + Integer.toHexString(first.get(s)));
  }

  static String unhex(String h) {
    byte[] b = new byte[h.length() / 2];
    for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16);
    return new String(b, StandardCharsets.UTF_8);
  }
}
