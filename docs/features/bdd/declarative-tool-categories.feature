Feature: Declarative tool categories
  Slash-menu categories are declared by each tool's OWNER at registration time
  via CapabilityDefinition.category, instead of hardcoded per-tool string lists
  inside CapabilityRegistry.getSlashCommands (F3.15 — the registry must not
  know tool names). The registry keeps only two STRUCTURAL fallbacks:
  the "mcp__" name prefix convention maps to "mcp", everything else to "general".

  Scenario: Tool registered with an explicit category
    Given a capability "cron_create" registered with category "cron"
    When slash commands are listed
    Then the entry for "cron_create" has category "cron"

  Scenario: MCP-shaped name without explicit category falls back to "mcp"
    Given a capability "mcp__github__search" registered without a category
    When slash commands are listed
    Then the entry for "mcp__github__search" has category "mcp"

  Scenario: Unknown tool without category falls back to "general"
    Given a capability "whatever_tool" registered without a category
    When slash commands are listed
    Then the entry for "whatever_tool" has category "general"

  Scenario: Explicit category wins over the mcp prefix fallback
    Given a capability "mcp__srv__tool" registered with category "custom"
    When slash commands are listed
    Then the entry for "mcp__srv__tool" has category "custom"

  Scenario: Loader tools declare category in their JSON definition
    Given the JSON tool definition "capabilities/bash.json" contains "category": "filesystem"
    When the CapabilityLoaderPiece registers it
    Then the entry for "bash" has category "filesystem"

  Scenario: Plugin JSON exec tools may declare a category
    Given a plugin tool definition with "category": "browser"
    When the PluginManager registers it
    Then the slash entry for that tool has category "browser"
