@echo off
title SnapShift Studio — Web Dashboard Launcher
color 0B
echo ====================================================================
echo        SNAPSHIFT STUDIO: SSD UPGRADE & MIGRATION SUITE
echo ====================================================================
echo.
echo Starting local migration studio server on http://127.0.0.1:4242...
echo.
start "" "http://127.0.0.1:4242"
node server.js
pause
