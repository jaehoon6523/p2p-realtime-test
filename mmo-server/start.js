from pathlib import Path
import json, shutil, zipfile, re

base = Path("/mnt/data")
deploy = base / "mmo-server-clean"
if deploy.exists():
    shutil.rmtree(deploy)
deploy.mkdir()

# Use the current signal-protocol-5 server that matches the AUTO browser client.
server_src = base / "mmo-server-v5-deploy" / "signaling-server.js"
server_dst = deploy / "signaling-server.js"
shutil.copyfile(server_src, server_dst)

package = {
    "name": "p2p-mmo-signaling",
    "version": "0.5.1",
    "description": "PSSF sparse signaling server for browser-native manual/auto peers",
    "main": "signaling-server.js",
    "scripts": {
        "start": "node signaling-server.js"
    },
    "dependencies": {
        "ws": "^8.18.0"
    }
}
(deploy / "package.json").write_text(
    json.dumps(package, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8"
)

# Cross-check protocol compatibility against canonical AUTO client.
client_text = (base / "p2p-mmo-demo-auto.html").read_text(encoding="utf-8")
server_text = server_dst.read_text(encoding="utf-8")
checks = {
    "client_signal_5": "const SIGNAL_PROTOCOL = 5;" in client_text,
    "client_protocol_13": "const PROTOCOL = 13;" in client_text,
    "client_ruleset": "const RULESET_REVISION = 'pssf-v13-r1';" in client_text,
    "server_signal_5": "const SIGNAL_PROTOCOL = 5;" in server_text,
    "server_ruleset": "const RULESET_REVISION = 'pssf-v13-r1';" in server_text,
    "package_direct_start": '"start": "node signaling-server.js"' in (deploy / "package.json").read_text(encoding="utf-8"),
}

if not all(checks.values()):
    raise RuntimeError(f"compatibility check failed: {checks}")

# Ensure forbidden legacy bot startup references do not exist in clean deployment.
combined = (deploy / "package.json").read_text(encoding="utf-8") + "\n" + server_text
for forbidden in ["node start.js", "server-bots/bot-runner.js", "BOT_COUNT", "BOT_TRANSPORT", "werift"]:
    if forbidden in combined:
        raise RuntimeError(f"legacy reference remained: {forbidden}")

zip_path = base / "mmo-server-clean-no-bots.zip"
if zip_path.exists():
    zip_path.unlink()
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(deploy / "package.json", "mmo-server/package.json")
    z.write(deploy / "signaling-server.js", "mmo-server/signaling-server.js")

print("Compatibility checks:")
for k, v in checks.items():
    print(f"  {k}: {v}")
print("\nFiles:")
print("  mmo-server/package.json")
print("  mmo-server/signaling-server.js")
print("\nZIP:", zip_path)
