# MCP-Zugriff auf dieses Replit-Projekt

Der API-Dienst stellt unter `/api/mcp` einen zentralen MCP-Gateway über Streamable HTTP bereit. Arena, Claude und weitere MCP-Clients können denselben Endpunkt verwenden. Der Endpunkt ist mit einem Bearer-Token geschützt.

## Client-Konfiguration

Die genaue öffentliche URL hängt von der Preview- oder Published-Domain dieses Projekts ab. Verwende:

```text
https://<deine-replit-domain>/api/mcp
```

Beispiel für einen MCP-Client, der Streamable HTTP unterstützt:

```json
{
  "mcpServers": {
    "replit-project": {
      "type": "streamable-http",
      "url": "https://<deine-replit-domain>/api/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

`<MCP_AUTH_TOKEN>` ist der Wert des Replit Secrets mit genau diesem Namen. Der Wert wird nicht in dieses Repository geschrieben. Claude, Arena und andere Clients verwenden dieselbe URL und denselben Authentifizierungsmechanismus.

## Projekte auswählen

Der Gateway wählt niemals automatisch ein Projekt aus. Zuerst kann der Client das Tool `workspace_list_projects` aufrufen. Jeder weitere Datei-, Shell- oder Log-Aufruf muss eine `projectId` enthalten:

```json
{
  "projectId": "gateway",
  "path": "artifacts/api-server/src/index.ts"
}
```

Die verfügbaren Projekte werden aus `config/mcp-projects.json` geladen:

```json
{
  "projects": [
    {
      "id": "gateway",
      "name": "Replit MCP Gateway",
      "root": ".",
      "enabled": true
    },
    {
      "id": "another-project",
      "name": "Another Replit Project",
      "root": "/path/visible/to/the/gateway",
      "enabled": true
    }
  ]
}
```

Relative Roots beziehen sich auf die Wurzel des Gateway-Projekts. Absolute Roots müssen im Laufzeitkontext des Gateway-Dienstes erreichbar sein. Bei separaten Replit-Projekten muss deren Workspace daher zuerst über die gewählte Laufzeit- oder Mount-Konfiguration sichtbar gemacht werden. Der MCP-Server muss dafür nicht neu gebaut werden; die Registry wird bei Zugriffen neu geladen.

## Verfügbare Tools

- `workspace_list_files` — Dateien und Verzeichnisse innerhalb des Projekts auflisten
- `workspace_read_file` — UTF-8-Datei lesen
- `workspace_write_file` — UTF-8-Datei erstellen oder überschreiben
- `workspace_run_shell` — Bash-Befehl im Projekt ausführen, inklusive Timeout und begrenzter Ausgabe
- `workspace_get_logs` — begrenzte, projektbezogene MCP-Aktivitätslogs dieses Serverprozesses abrufen
- `workspace_list_projects` — konfigurierte Projekt-IDs auflisten, ohne Projektdateien zu lesen

## Sicherheitsgrenzen

- Nur relative Pfade innerhalb des Projektverzeichnisses werden akzeptiert.
- Absolute Pfade und Symlink-Ausbrüche werden abgelehnt.
- `.env`-Dateien, private Schlüssel und typische Credential-Dateien sind für Datei-Tools gesperrt.
- Shell-Prozesse erhalten keine Secret-, Token-, Passwort-, Private-Key- oder API-Key-Umgebungsvariablen.
- Shell-Befehle laufen höchstens 120 Sekunden; die Ausgabe ist begrenzt.
- Lösch-, Publish-, Push- und Deploy-Muster werden ohne `allowDangerous: true` abgelehnt und als explizit freizugebende Aktionen protokolliert.
- Es gibt kein MCP-Lösch- oder Deploy-Tool.
- Der Token ist ein privilegierter Projektschlüssel. Gib ihn nur an einen Agenten weiter, dem du vollständigen Lese-, Schreib- und Ausführungszugriff auf dieses Projekt anvertrauen würdest.

Der Server ist kein isolierter Container und ersetzt keine Sicherheitsgrenze gegenüber einem bereits kompromittierten Token. Für mehrere unabhängige oder nicht vollständig vertrauenswürdige Agenten sollten separate Projekte beziehungsweise separate Tokens und zusätzliche Zugriffskontrollen verwendet werden.