# The official node image through Google's mirror of Docker Hub, which some networks block.
ARG BASE_IMAGE=mirror.gcr.io/library/node:24-bookworm-slim
FROM ${BASE_IMAGE}

ARG GO_VERSION=1.27.1
ARG GO_SHA256_amd64=63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445
ARG GO_SHA256_arm64=3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

# python3 runs the guard and the hidden checks; the rest is what an agent reaches for in a shell.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less procps python3 ripgrep tini \
    && rm -rf /var/lib/apt/lists/*

# Go, for the drift tasks
RUN set -eux; \
    sha="$(eval echo \$GO_SHA256_${TARGETARCH})"; \
    curl -fsSLo /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz"; \
    echo "${sha}  /tmp/go.tgz" | sha256sum -c -; \
    tar -C /usr/local -xzf /tmp/go.tgz; \
    rm /tmp/go.tgz

# CGO off: there is no C compiler in here, and the tasks are pure Go.
ENV PATH=/usr/local/go/bin:/home/node/go/bin:$PATH \
    GOPATH=/home/node/go \
    GOTOOLCHAIN=local \
    CGO_ENABLED=0 \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    CLAUDE_CODE_DISABLE_MOUSE=1

RUN npm install -g @anthropic-ai/claude-code \
    && mkdir -p /home/node/go/pkg/mod /home/node/.cache /home/node/.claude /work \
    && chown -R node:node /home/node /work

# System-wide git settings, since the home directory is read-only at run time: a neutral identity
# so commits in a merge task work without borrowing yours, and any repo owner accepted for the
# bind mount.
RUN git config --system user.name devbox \
    && git config --system user.email devbox@localhost \
    && git config --system --add safe.directory '*'

# The guard. Managed settings outrank the user's and project's, and both files are root-owned on a
# read-only filesystem, so the agent can neither edit nor switch off the hook.
COPY guard.py otel-relay.js /usr/local/lib/devbox/
COPY managed-settings.json /etc/claude-code/managed-settings.json
# An organisation's server-side managed settings replace this file outright when the box is logged
# in to such an account, guard and all. Settings passed with --settings are merged in instead, so
# `claude` here always passes the guard's file too.
RUN printf '#!/bin/sh\nexec %s --settings /etc/claude-code/managed-settings.json "$@"\n' \
      "$(readlink -f /usr/local/bin/claude)" > /usr/local/lib/devbox/claude \
    && chmod 755 /usr/local/lib/devbox/claude \
    && ln -sf /usr/local/lib/devbox/claude /usr/local/bin/claude
COPY entrypoint.sh /usr/local/bin/devbox-entrypoint
RUN printf 'export PATH=/usr/local/go/bin:/home/node/go/bin:$PATH\n' > /etc/profile.d/devbox-path.sh

USER node
WORKDIR /work

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/devbox-entrypoint"]
CMD ["bash", "-l"]
