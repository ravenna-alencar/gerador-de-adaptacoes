r"""
Conectar minha conta do Catalog
===============================

Roda na máquina da pessoa, uma vez (e de novo quando o acesso dela expirar).

O que ele faz, do ponto de vista dela:
  1. pede o código que apareceu no site do Gerador de Adaptações
  2. abre uma janela do Chrome no Catalog
  3. ela faz o login normal, com a conta dela
  4. a janela fecha sozinha e o acesso fica guardado

## Por que isso precisa ser um programa e não um botão no site

A sessão do Catalog são cookies que pertencem ao `catalog-v3.gocase.com.br`. Um
site não consegue ler os cookies de outro site -- é uma trava do navegador, e
ainda bem: sem ela qualquer página aberta poderia pegar o login do seu banco.
Então a captura só pode acontecer num programa que controla o navegador por
fora. É este aqui.

## Por que o código de pareamento

Este programa precisa provar pra ponte de quem é a sessão que ele está
entregando. Dar o token do sistema pra cada máquina do time seria espalhar a
chave-mestra. Em vez disso, o site mostra um código de uso único pra pessoa
logada, ela cola aqui, e a ponte confere: "esse código eu dei pra fulana,
então essa sessão é da fulana".

## Por que Chrome de verdade e não o navegador automatizado

O Google recusa login vindo de navegador automatizado (testado: cai em
`accounts.google.com/v3/signin/rejected`). Com o Chrome instalado na máquina e
uma pessoa de carne e osso clicando, passa normalmente.

Uso:
    venv\Scripts\python.exe conectar_catalog.py
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

PONTE_URL = os.environ.get("PONTE_URL", "https://rpa-ponte.devgogroup.com").rstrip("/")
LOGIN_URL = "https://catalog-v3.gocase.com.br/login"
PRONTO = "admin/customizations"

# Sem isto a plataforma recusa com 403: ela bloqueia o "Python-urllib/3.x" que
# o urllib manda por padrão. Qualquer outro nome passa.
IDENTIFICACAO = "conectar-catalog/1.0"


def enviar(codigo: str, auth_state: str) -> dict:
    corpo = json.dumps({"codigo": codigo, "auth_state": auth_state}).encode("utf-8")
    req = urllib.request.Request(
        f"{PONTE_URL}/sessao",
        data=corpo,
        headers={"content-type": "application/json", "user-agent": IDENTIFICACAO},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    print()
    print("=" * 64)
    print("  Conectar minha conta do Catalog")
    print("=" * 64)
    print()
    print("  No site do Gerador de Adaptações, aba 'Cadastrar no Catalog',")
    print("  clique em 'Conectar minha conta' -- vai aparecer um código.")
    print()

    codigo = input("  Digite o código (ex.: K7X-2M9): ").strip().upper()
    if not codigo:
        print("\n  Sem código não dá pra continuar. Rode de novo quando tiver.")
        return 1

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome", headless=False)
        except Exception:
            print()
            print("  Não achei o Google Chrome instalado nesta máquina.")
            print("  Instale o Chrome e rode de novo -- o navegador de reserva")
            print("  costuma ser recusado pelo Google na hora do login.")
            return 1

        context = browser.new_context()
        page = context.new_page()
        try:
            page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60000)
        except Exception:
            pass  # a janela abriu; o resto a pessoa resolve

        print()
        print("  " + "-" * 60)
        print("  Abri uma janela do Chrome. Faça o login com a SUA conta.")
        print("  Quando a tela de Customizações aparecer, eu salvo sozinho.")
        print("  Não feche a janela.")
        print("  " + "-" * 60)
        print()

        # Espera sem limite: quem está do outro lado é uma pessoa, e ela pode
        # precisar pegar o celular pra ver o código de 6 dígitos.
        while True:
            try:
                page.wait_for_url(f"**/{PRONTO}**", timeout=5000)
                page.wait_for_timeout(1500)
                if PRONTO in page.url:
                    break
            except Exception:
                if page.is_closed():
                    print("  A janela foi fechada antes do login. Nada foi salvo.")
                    browser.close()
                    return 1

        estado = json.dumps(context.storage_state(), ensure_ascii=False)
        browser.close()

    print("  Login feito. Enviando seu acesso...")
    try:
        r = enviar(codigo, estado)
    except urllib.error.HTTPError as e:
        detalhe = e.read().decode("utf-8", "replace")[:300]
        print()
        print(f"  Não deu certo ({e.code}): {detalhe}")
        if e.code == 401:
            print()
            print("  Provavelmente o código expirou (ele vale 10 minutos) ou já")
            print("  foi usado. Peça um novo no site e rode de novo.")
        return 1
    except Exception as e:
        print(f"\n  Não consegui falar com o servidor: {e}")
        return 1

    print()
    print("=" * 64)
    print(f"  Pronto! Seu acesso ao Catalog está guardado ({r.get('conta', '')}).")
    print("  Pode fechar esta janela e usar o site normalmente.")
    print("=" * 64)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
