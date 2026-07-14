export type ToolRisk = 'read' | 'write';
export type ToolSurface = 'mini' | 'catalog' | 'mode' | 'direct';
export type RegisteredConnectorId = 'tinyfish';
export type RegisteredToolId = 'web_search' | 'web_fetch';

export type RegisteredConnector = {
  id: RegisteredConnectorId;
  capabilities: readonly ['search', 'fetch'];
};

export type RegisteredTool = {
  id: RegisteredToolId;
  title: string;
  description: string;
  connectorId: RegisteredConnectorId;
  risk: 'read';
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  immutable: true;
};

export type ToolPolicyOverride = {
  toolId: RegisteredToolId;
  enabled: boolean;
  scopes: Record<ToolSurface, boolean>;
};

export type ToolRuntimeConfig = {
  version: 1;
  enabled: boolean;
  orchestrator: {
    primaryCatalogId: string | null;
    fallbackCatalogId: string | null;
  };
  connectors: {
    tinyfish: {
      enabled: boolean;
      searchRequestsPerMinute: number;
      fetchUrlsPerMinute: number;
      searchCacheSeconds: number;
      fetchCacheSeconds: number;
    };
  };
  toolOverrides: ToolPolicyOverride[];
};

export type ToolConfigValidationError = {
  path: string;
  code: string;
  message: string;
};

export type ConnectorCredentialMetadata = {
  credentialConfigured: boolean;
  credentialHint: string | null;
};

export type ToolSource = {
  title: string | null;
  url: string;
  snippet: string | null;
};

export type NormalizedToolResult = {
  content: string;
  structuredContent?: Record<string, unknown>;
  sources: ToolSource[];
  truncated: boolean;
};
