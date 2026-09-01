@echo off
title Preparar o Conectar Catalog
cd /d "%~dp0"

echo.
echo   Preparando este computador. So precisa ser feito uma vez.
echo   Pode levar alguns minutos.
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo   Python nao foi encontrado neste computador.
  echo   Instale em https://python.org (marque "Add to PATH") e clique aqui de novo.
  echo.
  pause
  exit /b 1
)

if not exist "venv\Scripts\python.exe" python -m venv venv
venv\Scripts\python.exe -m pip install --upgrade pip -q
venv\Scripts\python.exe -m pip install -r requirements.txt -q
venv\Scripts\python.exe -m playwright install chromium

echo.
echo   Pronto. Agora use o "Conectar_Catalog".
echo.
pause
