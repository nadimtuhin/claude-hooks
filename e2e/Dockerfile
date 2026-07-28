# node:22-alpine, not raw alpine: @anthropic-ai/claude-code declares
# engines.node >= 22 and Alpine's own nodejs package lags behind that.
FROM node:22-alpine

# Base Alpine has BusyBox ash, not bash — the hooks are #!/usr/bin/env bash and
# will not run without it. jq and git are likewise absent.
# ripgrep: the copy bundled with claude-code is glibc-linked and fails on musl,
# usually as a silent empty search rather than a clean crash. Install the musl
# build and point claude-code at it.
RUN apk add --no-cache bash jq git ripgrep coreutils diffutils make

ENV USE_BUILTIN_RIPGREP=0

# Every hook path is $HOME/.claude/..., so the test user needs a real home.
RUN adduser -D -h /home/tester tester
USER tester
WORKDIR /home/tester
ENV HOME=/home/tester

COPY --chown=tester:tester . /home/tester/claude-hooks
WORKDIR /home/tester/claude-hooks

# Assert the musl hazards are actually resolved rather than assuming it.
RUN set -eu; \
    bash --version >/dev/null; \
    jq --version >/dev/null; \
    git --version >/dev/null; \
    printf 'needle\n' > /tmp/rg-probe.txt; \
    rg needle /tmp/rg-probe.txt >/dev/null || { echo 'ripgrep is broken on musl' >&2; exit 1; }; \
    echo "preflight ok: bash $(bash --version | head -1), $(jq --version), $(rg --version | head -1)"

CMD ["bash", "e2e/tier1.sh"]
