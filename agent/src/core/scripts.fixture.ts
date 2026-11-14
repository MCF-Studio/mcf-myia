/** Serveur MCP minimal en Python pur (bibliothèque standard) : un outil « dire » qui répète son texte. */
export const ECHO_SERVER = `import json
import sys


def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    mid, method = msg.get("id"), msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": msg["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "echo", "version": "1"},
        }})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [{
            "name": "dire",
            "description": "Répète le texte reçu",
            "inputSchema": {"type": "object", "properties": {"texte": {"type": "string"}}, "required": ["texte"]},
        }]}})
    elif method == "tools/call":
        texte = msg["params"]["arguments"]["texte"]
        send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "echo : " + texte}]}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "inconnu"}})
`;
