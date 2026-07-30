#!/usr/bin/env python3
"""Serveur HTTP du banc d'essai.

Deux rôles :
  - servir le dossier de l'outil (l'application est un module ES : un
    navigateur refuse de la charger depuis file://, il faut du HTTP) ;
  - recevoir les résultats que la page envoie en POST sur /__resultats et
    les écrire dans genere/resultats.json, où lancer.sh les lit pour
    produire un code de sortie.

Écoute sur un port libre choisi par le système et l'annonce sur stdout
(« PORT=12345 ») pour que lancer.sh le récupère.
"""

import http.server
import pathlib
import sys

ICI = pathlib.Path(__file__).resolve().parent
RACINE = ICI.parent          # le dossier de l'outil : /css, /js, /tests…
RESULTATS = ICI / "genere" / "resultats.json"


class Poignee(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(RACINE), **kwargs)

    def do_POST(self):
        if self.path != "/__resultats":
            self.send_response(404)
            self.end_headers()
            return
        longueur = int(self.headers.get("Content-Length", 0))
        corps = self.rfile.read(longueur)
        RESULTATS.parent.mkdir(exist_ok=True)
        RESULTATS.write_bytes(corps)
        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        # Jamais de cache : le banc doit servir les fichiers de CE run.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass  # silence : lancer.sh présente les résultats, pas le journal HTTP


def main():
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Poignee) as httpd:
        print(f"PORT={httpd.server_address[1]}", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
