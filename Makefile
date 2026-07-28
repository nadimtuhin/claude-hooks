IMAGE := claude-hooks-e2e

.PHONY: test e2e e2e-host e2e-live shell clean

# Unit tests. No container, no key.
test:
	cd hooks/no-slop && node --test

# Tier 1 in Alpine/musl. Deterministic, no API key — this is the CI gate.
e2e:
	docker build -f e2e/Dockerfile -t $(IMAGE) .
	docker run --rm $(IMAGE)

# Same assertions on the host. Faster, but proves nothing about musl.
e2e-host:
	bash e2e/tier1.sh

# Tier 2: drives a real headless session. Opt-in, costs tokens, nondeterministic.
# Only this proves settings.json registration actually causes the hook to fire.
e2e-live:
	@test -n "$$ANTHROPIC_API_KEY" || { echo 'e2e-live needs ANTHROPIC_API_KEY'; exit 1; }
	docker build -f e2e/Dockerfile -t $(IMAGE) .
	docker run --rm -e ANTHROPIC_API_KEY \
		$(IMAGE) bash -c 'npm i -g @anthropic-ai/claude-code >/dev/null 2>&1 && bash e2e/tier2.sh'

shell:
	docker build -f e2e/Dockerfile -t $(IMAGE) .
	docker run --rm -it $(IMAGE) bash

clean:
	-docker rmi $(IMAGE)
