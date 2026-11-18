# Services à connecter à MyIA

Ce que MyIA sait déjà relier, et les services qui ont une API utile à l'app, classés par intérêt pour ses
utilisateurs (créateurs, développeurs de jeux, streamers, maison connectée). Pour chacun : ce qu'il apporterait,
comment il s'authentifie, et la règle de MyIA qui s'applique (lecture sans confirmation, action avec confirmation,
jeton dans le coffre Windows, adresse figée).

## Déjà relié

| Service | Comment | Où |
| --- | --- | --- |
| Modèles locaux | Ollama, llama.cpp | Paramètres → Système |
| Claude | Claude Code (consoles, délégation), API Claude | Paramètres → Général |
| Autres IA | OpenAI, Gemini, Mistral, OpenRouter, Groq, DeepSeek, xAI (API compatible OpenAI) | Paramètres → Général → Autres IA |
| Autres IA de code en console | Codex, Gemini CLI, opencode, Qwen Code (s'ils sont installés) | Conversations → nouvelle console |
| Serveurs MCP | n'importe quel serveur stdio, pour TOUS les modèles ; import depuis Claude Code | Paramètres → Général → Serveurs MCP |
| Messageries | bots Telegram et Discord | Paramètres → Général → Bots |
| Domotique | Home Assistant (API REST, jeton longue durée) | Paramètres → Appareils et domotique |
| Contrôle de l'écran | AutoHotkey v2 : cliquer, taper, raccourcis, défiler, glisser (avec confirmation) | Paramètres → Appareils et domotique |
| Appareils | Bluetooth, ports COM, réseau local (SSDP), box internet | Paramètres → Appareils et domotique |
| Suivi de travail | script `exec:` (GitHub Issues, bd, Jira…) | config/agent.json → work.provider |

## Domotique : pourquoi passer par Home Assistant

La box internet (Bbox, Freebox, Livebox, SFR) ne pilote pas les appareils de la maison ; son API locale sert surtout
au réseau (appareils connectés, Wi-Fi, redirections de ports). La domotique passe par un **hub** :

- **Home Assistant** (gratuit, libre) : plus de 2 000 intégrations (Hue, IKEA, Xiaomi, Shelly, Tuya, Sonos, Netatmo,
  chauffage, Linky…), Zigbee et Z-Wave par une **clé USB** (Sonoff ZBDongle, SkyConnect, ConBee, Aeotec), Matter et
  Thread. MyIA lui parle par son API REST : c'est le choix retenu (un seul connecteur au lieu d'un par marque).
- La clé Zigbee / Z-Wave se branche sur la machine de Home Assistant ; si c'est ce PC, MyIA la reconnaît dans les
  ports COM (identifiant USB).
- Bluetooth : utile pour des capteurs basse consommation (thermomètres Xiaomi, plantes) via Home Assistant, ou pour
  des casques et manettes ; ce PC n'a pas de carte, une clé USB Bluetooth 5 suffit.

API des box (à relier plus tard, seulement si un besoin réel apparaît) :

| Box | API | Authentification |
| --- | --- | --- |
| Bbox (Bouygues) | `https://mabbox.bytel.fr/api/v1` (appareils connectés, Wi-Fi, NAT) | mot de passe administrateur (cookie de session) |
| Freebox (Free) | Freebox OS `http://mafreebox.freebox.fr/api/` (très complète : réseau, téléchargements, TV, domotique Free) | jeton d'application validé sur l'écran de la box |
| Livebox (Orange) | `sysbus` (JSON-RPC) | mot de passe administrateur |

## À relier ensuite (par ordre d'intérêt)

| Service | Ce qu'il apporte | Auth | Remarques |
| --- | --- | --- | --- |
| **GitHub** | issues, PR, releases, CI de ses projets ; base du fournisseur `exec:` | jeton à portée fine (lecture d'abord) | `gh` est souvent déjà installé : le réutiliser |
| **Google Agenda / Gmail** | planning, rappels du briefing de Jarvis, brouillons de mails | OAuth (Google Cloud, écran de consentement) | lecture seule d'abord ; envoyer = confirmation |
| **Microsoft 365 (Outlook, OneDrive, To Do)** | idem pour les comptes pro | OAuth Microsoft Graph | |
| **Notion** | notes, bases de tâches | jeton d'intégration interne | |
| **Spotify** | musique pendant le travail, commandes vocales de Jarvis | OAuth PKCE | le contrôle de lecture demande un compte Premium |
| **Twitch / YouTube** | streamers : titres, catégories, clips, chat, statistiques | OAuth (Twitch Helix, YouTube Data API) | complète MCF VideoCut |
| **OBS Studio** | scènes, enregistrement, stream depuis Jarvis | obs-websocket (local, mot de passe) | local, aucun compte |
| **Météo (Open-Meteo)** | briefing du matin, alertes | aucune clé | gratuit, sans compte : bon premier service |
| **Itch.io / Steamworks** | publication et statistiques des jeux | clé d'API | pour les développeurs de jeux |
| **Stable Diffusion (ComfyUI local)** | images générées en local | API locale | cohérent avec le « tout local » |
| **ElevenLabs** | voix de synthèse haut de gamme | clé d'API | Piper reste la voix locale gratuite |
| **Philips Hue (direct)** | lumières sans Home Assistant | bouton du pont + clé locale | seulement si l'utilisateur n'a pas Home Assistant |

## Règles pour chaque nouveau connecteur

1. Jeton ou clé dans le coffre Windows, vérifié à l'enregistrement, jamais renvoyé à l'interface (seule sa fin).
2. Adresse figée ou validée (https, ou réseau local pour un service maison), redirections refusées.
3. Lire = sans confirmation ; agir = confirmation (risque `local` ou `external`) ; rien d'irréversible par défaut.
4. Ce que renvoie le service est présenté aux agents comme des **données**, jamais comme des consignes.
5. Un connecteur sert à tous les modèles (local comme en ligne) ; un agent « en ligne » n'a pas la mémoire.
