# =============================================================================
# Git MCP Server - Production Dockerfile  
# =============================================================================
# Multi-stage build using Bun runtime with Debian for compatibility.
# Supports streamable HTTP transport for MCP protocol.
#
# Build: docker build -t git-mcp-server .
# Run:   docker run -p 3015:3015 git-mcp-server
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies
# -----------------------------------------------------------------------------
FROM oven/bun:1.2-debian AS deps

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2: Production
# -----------------------------------------------------------------------------
FROM oven/bun:1.2-debian AS production

# Install git and runtime dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        git-lfs \
        openssh-client \
        ca-certificates \
        curl \
    && git lfs install \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --system --gid 1001 mcpserver && \
    useradd --system --uid 1001 --gid mcpserver -m mcpserver

WORKDIR /app

# Copy dependencies and source
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

# Set permissions
RUN mkdir -p /app/logs /app/.storage && \
    chown -R mcpserver:mcpserver /app

USER mcpserver

# =============================================================================
# Environment Configuration
# =============================================================================
ENV NODE_ENV=production
ENV MCP_TRANSPORT_TYPE=http
ENV MCP_HTTP_PORT=3015
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_ENDPOINT_PATH=/mcp
ENV MCP_LOG_LEVEL=info
ENV STORAGE_PROVIDER_TYPE=in-memory
ENV GIT_SIGN_COMMITS=false

EXPOSE 3015

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl --fail http://localhost:3015/healthz || exit 1

# Run the server with Bun
CMD ["bun", "run", "src/index.ts"]
