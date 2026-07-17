# Governed-Brain MCP Server Registration

The governed-brain MCP server is the plugin's stdio entry point. A recurring
misconfiguration is registering governed-brain twice — once from the plugin
manifest and once hand-added to the user scope — which makes every tool appear
duplicated in the client's tool list.

The fix is to keep exactly one registration: remove the hand-added user-scope
entry and let the plugin manifest own the governed-brain server. After the
duplicate registration is removed, restart the session and verify the tool
list shows a single brain_search.
