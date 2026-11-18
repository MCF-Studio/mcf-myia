# Bien démarrer avec MyIA

Ce guide te mène de l'installation à un assistant qui travaille pour toi. Compte **20 à 30 minutes** pour le minimum,
le reste se fait quand tu en as envie. Chaque étape dit si elle est **indispensable** ou **en option**.

## 0. Ce qu'il te faut

| Quoi | Indispensable ? | Pourquoi |
| --- | --- | --- |
| Windows 10 ou 11 | oui | seule plateforme testée aujourd'hui |
| Une carte graphique avec **8 Go de VRAM** ou plus (NVIDIA conseillée) | conseillé | le modèle local tourne dessus. Avec moins, choisis un modèle plus petit (ex. Qwen3 4B) ou passe par une IA en ligne (étape 6) |
| ~10 Go d'espace disque | oui | un modèle local pèse 3 à 9 Go |
| Ollama | oui (ou llama.cpp) | c'est lui qui fait tourner les modèles sur ta machine. MyIA peut l'installer pour toi |
| Un abonnement Claude + Claude Code | en option | pour déléguer les grosses tâches (code, builds cassés) et ouvrir des consoles Claude dans l'app |
| Une clé d'API (Claude, OpenAI, Gemini, Mistral…) | en option | pour des agents plus puissants que le modèle local, facturés à l'usage |
| Un bot Telegram ou Discord | en option | pour que tes agents envoient des messages |
| Python | en option | pour la boîte à outils (images, Blender…) |

## 1. Installer MyIA (indispensable)

1. Télécharge `MyIA_x.y.z_x64-setup.exe` dans les [Releases](https://github.com/MCF-Studio/mcf-myia/releases) et lance-le.
   Pas besoin de droits administrateur.
2. Windows peut afficher « Windows a protégé votre ordinateur » : l'installateur n'est pas encore signé. Clique sur
   **Informations complémentaires → Exécuter quand même**. L'empreinte SHA-256 est publiée avec chaque release si tu veux
   vérifier le fichier.
3. Les mises à jour se font ensuite toutes seules au démarrage (signature vérifiée).

## 2. Le moteur et un premier modèle (indispensable)

1. **Paramètres → Système → Installer Ollama** (si tu ne l'as pas déjà).
2. Onglet **Modèles** : télécharge `qwen3:8b`. C'est un bon début : il est rapide et sait utiliser les outils. Avec moins
   de 8 Go de VRAM, prends un modèle plus petit.
3. Choisis-le comme **modèle par défaut**.

> Tu as une carte NVIDIA et tu veux aller plus vite ? Dans **Paramètres → Système**, le moteur **llama.cpp** est une
> alternative à Ollama (modèles du catalogue vérifiés).

## 3. Te présenter (indispensable, 1 minute)

**Paramètres → Général** :
- **Ton prénom** : c'est comme ça que tes agents t'appellent.
- **Tes dossiers de projets** : MyIA y repère tes projets (Godot, Tauri, Rust, Node, dépôts git) pour les builds et
  Claude Code.

## 4. Ton premier agent et ton premier échange (indispensable)

1. Onglet **Agents → Nouvel agent** : un nom, un modèle (vide = celui par défaut), quelques consignes (« Tu m'aides à
   organiser mes journées », « Tu es mon assistant de dev Godot »…).
2. Coche **Agent MASTER** sur ton agent principal. MASTER est ton assistant du quotidien : il peut créer des
   conversations, écrire aux autres agents et piloter l'app. Créer, supprimer ou publier te sont toujours demandés.
3. Onglet **Conversations** : écris-lui. Essaie :
   - « Quels projets tu vois sur mon PC ? »
   - « Ouvre mon dossier Musique et lance une playlist »
   - « Rappelle-moi dans 20 minutes de sortir le linge »

**La règle d'or** : avant toute action sensible (écrire un fichier, lancer un build, envoyer un message), MyIA te montre
**exactement** ce qu'il va faire et attend ton accord. Lis avant de dire oui.

## 5. Lui parler à la voix (en option, mais c'est là que ça devient fun)

- **Touche « parler » (F9 par défaut)** : maintiens-la, parle, relâche. Ta voix est transcrite **sur ton PC** et
  envoyée à MASTER, même si la fenêtre est cachée. La touche se change dans **Paramètres → Son et voix**.
- **Onglet Jarvis** : donne-lui le **nom de ton choix**, qui sert aussi de mot d'éveil. Tu y trouves le tableau de bord
  en direct, l'écoute mains libres (« Paul, quelle heure est-il ? »), les « oui »/« non » à voix haute pour les
  confirmations, une voix neuronale locale et « regarde mon écran ».
- ⚠️ Le **mode libre** de Jarvis est activé par défaut. Dans ce mode, son agent a accès à tout ton PC (terminal), sans
  confirmation. Un bandeau rouge le signale. Coupe-le si tu préfères que tout te soit demandé.

## 6. Brancher une IA en ligne (en option)

Le modèle local est gratuit et privé, mais limité par ta carte graphique. Pour un agent plus capable :

| Option | Où | Coût |
| --- | --- | --- |
| **Claude par ton abonnement** | installe [Claude Code](https://claude.com/claude-code) et connecte-toi, puis Agents → Modèle → « Claude » | compris dans ton abonnement |
| **API Claude** | Paramètres → Général → Clé d'API Claude, puis Agents → Modèle → « API Claude » | à l'usage, chez Anthropic |
| **Autres IA** : OpenAI (ChatGPT), Google Gemini, Mistral, OpenRouter, Groq, DeepSeek, xAI (Grok) | Paramètres → Général → **Autres IA** : colle ta clé (elle est vérifiée), puis Agents → Modèle → « Autres IA » → choisis le fournisseur et le modèle dans la liste | à l'usage, chez le fournisseur |

À savoir avant de choisir :
- Ce que tu écris à un agent en ligne, et ce que ses outils lisent, **part chez le fournisseur**. Ta **mémoire** (tes
  notes) ne lui est jamais envoyée.
- Les clés sont rangées dans le **coffre Windows**, jamais dans un fichier. Elles ne partent que vers l'adresse officielle
  du fournisseur.
- **Fixe une limite de dépense** sur le site du fournisseur. MyIA borne déjà la longueur des réponses et le nombre
  d'étapes par demande.
- Un agent en ligne peut être membre d'une équipe, mais pas proposé à la Guilde.

## 7. Envoyer des messages Telegram ou Discord (en option)

1. **Crée le bot.**
   - Telegram : écris à **@BotFather** → `/newbot` → copie le jeton.
   - Discord : [discord.com/developers](https://discord.com/developers/applications) → **New Application** → **Bot** →
     **Reset Token** → copie le jeton. Ensuite **OAuth2 → URL Generator**, coche `bot` et la permission « Send
     Messages », et ouvre le lien pour inviter le bot sur ton serveur.
2. **Paramètres → Général → Bots Telegram et Discord** : colle le jeton (il est vérifié).
3. **Déclare où le bot a le droit d'écrire.** Ouvre le fichier de configuration (**Paramètres → Système**, sous
   « Dossier MyIA », bouton à côté de `config/agent.json`) :
   ```json
   "discord":  { "channels":     { "annonces": "123456789012345678" } },
   "telegram": { "destinations": { "perso": "123456789" } }
   ```
   Pour l'ID d'un salon Discord : active **Paramètres Discord → Avancés → Mode développeur**, puis fais un clic droit sur
   le salon → **Copier l'identifiant du salon**.
4. Redémarre MyIA, puis demande : « Poste dans annonces : la mise à jour est en ligne ! ». Tu verras le texte exact avant
   l'envoi.

Les agents n'écrivent **qu'aux noms déclarés** : ils ne peuvent pas inventer un salon ou un destinataire.

## 8. Aller plus loin

- **Équipes** : un chef, des sous-agents, un budget d'appels, un dossier de travail et un registre de tâches. Pour les
  gros projets. Le bouton « ? » de l'écran Équipes explique tout.
- **Mémoire** (Paramètres → Général) : donne-lui un dossier de notes `.md` ou `.txt` (présentation de tes projets, tes
  habitudes…). Les agents locaux s'en servent. Elle ne quitte jamais ton PC.
- **Marketplace** : installe des équipes toutes prêtes (workflows) partagées sur mcfstudio.fr. MyIA te montre tout avant
  l'installation, y compris le code des scripts.
- **Guilde** : connecte ton compte mcfstudio.fr pour proposer tes agents aux autres membres, ou leur demander de l'aide.
  Les échanges sont chiffrés de bout en bout.
- **Boîte à outils** (Paramètres → Boîte à outils) : des outils Python (images, Blender…) que tes agents peuvent
  utiliser. Installe Python, puis Pillow avec le bouton « Installer ».
- **Programmes** : dis « trouve et enregistre Blender » ; ensuite « ouvre Blender » suffira.
- **Toutes les options** du fichier de configuration sont expliquées dans [CONFIG.md](CONFIG.md). MyIA les écrit toutes
  dans le fichier : une option vide garde sa valeur par défaut.

## En cas de souci

| Problème | Solution |
| --- | --- |
| « moteur local arrêté » | Paramètres → Système : démarre Ollama ou llama.cpp. Relance MyIA si besoin. |
| Réponses très lentes | Le modèle déborde de ta VRAM : prends un modèle plus petit (onglet Modèles). |
| « clé d'API … refusée » | La clé a été révoquée ou mal copiée : remplace-la dans Paramètres. |
| « aucun salon dans config > discord.channels » | Déclare le salon dans le fichier de configuration (étape 7.3). |
| « jeton absent » | Colle le jeton du bot dans Paramètres → Général → Bots. |
| L'agent ne voit pas mon projet | Ajoute son dossier parent dans Paramètres → Général (dossiers de projets). |

Une question ou une idée ? Viens en parler sur le Discord de MCF Studio.
Une faille de sécurité ? Pas d'issue publique : utilise **Security → Report a vulnerability** sur GitHub.
