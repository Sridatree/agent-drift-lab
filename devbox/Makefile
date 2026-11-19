# Run from this directory. `make install` puts devbox on your PATH so you can use it anywhere.
DEVBOX_DIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
PREFIX ?= $(HOME)/.local/bin
VOLUMES := $(foreach p,drift-devbox drift-devbox-quarantine,$(addprefix $(p)-,cache gomod claude))

.PHONY: help build rebuild shell install uninstall versions clean

help: ## Show this help
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | expand -t20

build: ## Build the image
	docker build -t drift-devbox:latest $(DEVBOX_DIR)

rebuild: ## Rebuild from scratch, ignoring the layer cache
	docker build --no-cache --pull -t drift-devbox:latest $(DEVBOX_DIR)

shell: ## Open a shell in the container (cwd mounted at /work)
	@$(DEVBOX_DIR)/devbox

versions: ## Print the toolchain versions inside the image
	@$(DEVBOX_DIR)/devbox bash -lc 'go version; git --version; python3 --version; \
	  echo "node $$(node --version)"; echo "claude $$(claude --version)"'

install: ## Symlink devbox into PREFIX (default ~/.local/bin) so it works from any folder
	@mkdir -p $(PREFIX)
	ln -sf $(DEVBOX_DIR)/devbox $(PREFIX)/devbox
	@echo "linked $(PREFIX)/devbox -> $(DEVBOX_DIR)/devbox"
	@command -v devbox >/dev/null || echo "warning: $(PREFIX) is not on your PATH"

uninstall: ## Remove the symlink
	rm -f $(PREFIX)/devbox

clean: ## Delete the image, helpers and all cache volumes (logins inside the container go too)
	-docker rm -f devbox-egress devbox-sink
	-docker network rm devbox-quarantine
	-docker rmi drift-devbox:latest
	-docker volume rm $(VOLUMES)
