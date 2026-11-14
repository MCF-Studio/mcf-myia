import os
import subprocess

# Titre et message passent par l'environnement, jamais dans le texte du script : pas d'injection PowerShell.
SCRIPT = (
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
    "$n = New-Object System.Windows.Forms.NotifyIcon;"
    "$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true;"
    "$n.ShowBalloonTip(6000, $env:MYIA_TITLE, $env:MYIA_MSG, 'Info');"
    "Start-Sleep -Seconds 7; $n.Dispose()"
)


def execute(params):
    title, msg = params["title"][:63], params["message"][:255]
    env = {**os.environ, "MYIA_TITLE": title, "MYIA_MSG": msg}
    subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-Command", SCRIPT], env=env,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=0x08000000)  # CREATE_NO_WINDOW
    return {"data": {"title": title, "message": msg}}
