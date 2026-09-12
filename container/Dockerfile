FROM docker:28-dind

RUN apk add --no-cache \
    nodejs npm \
    bash git ripgrep ca-certificates \
    curl jq \
    python3 py3-pip python3-dev \
    build-base libmagic clang clang-dev \
    libgcc libstdc++

RUN pip3 install --break-system-packages pre-commit

# Install uv (fast Python package manager)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Install Bun from its official Alpine image
COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
ENV BUN_INSTALL_BIN=/usr/local/bin

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
