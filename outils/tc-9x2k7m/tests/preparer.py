#!/usr/bin/env python3
"""Génère le banc d'essai dans tests/genere/ à partir des VRAIS fichiers.

Deux productions :
  genere/banc.html          — l'index.html réel, avec trois différences :
                              une carte d'imports détourne Firebase vers les
                              bouchons, le module chargé est la version
                              instrumentée, et tests.js s'exécute ensuite.
  genere/app-instrumente.js — js/app.js réel + pont.js collé à la suite.

Rien n'est copié à la main : si index.html ou app.js change, le banc suit
automatiquement à la prochaine exécution. Si la forme attendue n'est plus
reconnue, ce script échoue BRUYAMMENT plutôt que de produire un banc qui
testerait autre chose que l'application.
"""

import pathlib
import re
import sys

ICI = pathlib.Path(__file__).resolve().parent
OUTIL = ICI.parent
GENERE = ICI / "genere"

CARTE_IMPORTS = """<script>
  // AVANT les modules : une erreur pendant leur évaluation doit être
  // capturée, sinon le banc échoue en silence (page normale, zéro résultat).
  window.__erreursBanc = [];
  window.addEventListener("error", (e) =>
    __erreursBanc.push((e.message || "?") + " @ " + (e.filename || "") + ":" + (e.lineno || "")));
  window.addEventListener("unhandledrejection", (e) =>
    __erreursBanc.push("promesse rejetée : " + ((e.reason && e.reason.stack) || e.reason)));
  // Filet : si la suite n'a rien envoyé après 20 s (erreur de syntaxe dans un
  // module, par exemple), la page livre elle-même les erreurs capturées.
  window.__resultatsEnvoyes = false;
  setTimeout(() => {
    if (window.__resultatsEnvoyes) return;
    const tests = (window.__erreursBanc.length ? window.__erreursBanc : ["aucune erreur capturée — la suite n'a jamais démarré"])
      .map((m) => ({ section: "harnais", nom: "erreur fatale avant les tests", ok: false, message: String(m) }));
    fetch("/__resultats", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tests }) });
  }, 20000);
  </script>
  <script type="importmap">
  {
    "imports": {
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js": "/tests/bouchons/firebase-app.js",
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js": "/tests/bouchons/firebase-auth.js",
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js": "/tests/bouchons/firebase-firestore.js"
    }
  }
  </script>
  <script type="module" src="/tests/genere/app-instrumente.js"></script>
  <script type="module" src="/tests/tests.js"></script>"""


def echec(message):
    print(f"preparer.py : {message}", file=sys.stderr)
    print("Le banc n'a PAS été généré : la forme d'index.html ou d'app.js a "
          "changé et ce script doit être ajusté.", file=sys.stderr)
    sys.exit(2)


def main():
    index = (OUTIL / "index.html").read_text(encoding="utf-8")
    app = (OUTIL / "js" / "app.js").read_text(encoding="utf-8")
    pont = (ICI / "pont.js").read_text(encoding="utf-8")

    # --- banc.html : mêmes éléments, scripts détournés ---------------------
    html, n = re.subn(
        r'href="css/style\.css\?v=\d+"',
        'href="/css/style.css"',
        index,
    )
    if n != 1:
        echec(f"lien CSS « css/style.css?v=… » introuvable ou multiple ({n})")

    html, n = re.subn(
        r'<script type="module" src="js/app\.js\?v=\d+"></script>',
        CARTE_IMPORTS,
        html,
    )
    if n != 1:
        echec(f"balise <script type=\"module\" src=\"js/app.js?v=…\"> "
              f"introuvable ou multiple ({n})")

    html = html.replace(
        "<title>", "<title>[BANC D'ESSAI] ", 1
    )

    # --- app-instrumente.js : le vrai app.js + le pont ---------------------
    app_instrumente, n = re.subn(
        r'from "\./firebase-config\.js"',
        'from "/js/firebase-config.js"',
        app,
    )
    if n != 1:
        echec(f"import « ./firebase-config.js » introuvable ou multiple ({n})")

    GENERE.mkdir(exist_ok=True)
    (GENERE / "banc.html").write_text(html, encoding="utf-8")
    (GENERE / "app-instrumente.js").write_text(
        app_instrumente + "\n\n/* ===== pont.js (ajouté par preparer.py) ===== */\n" + pont,
        encoding="utf-8",
    )
    print(f"preparer.py : banc généré dans {GENERE}")


if __name__ == "__main__":
    main()
