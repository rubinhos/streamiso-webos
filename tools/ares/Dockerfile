# LG's webOS CLI (ares-setup-device, ares-install, ares-extend-dev, ...) in a container, so nothing needs to be
# installed on the PC besides Docker. Run it through tools/ares.ps1 or tools/ares.sh, which keep the TV's settings
# and key in .ares/ at the repository root.
FROM node:22-alpine

ARG ARES_VERSION=3.2.6
RUN npm install -g "@webos-tools/cli@${ARES_VERSION}" && npm cache clean --force

# The CLI keeps the TVs in ~/.webos and their SSH keys in ~/.ssh. The scripts mount .ares/ here.
ENV HOME=/home/ares
RUN mkdir -p /home/ares /work
WORKDIR /work
CMD ["ares", "--help"]
