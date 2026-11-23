# Disposable synthetic probe for the hosted sandbox proof. Build context:
# packages/workspace-infrastructure/sandbox-probe.
#   docker build --build-arg PROBE_BUILD_VERSION=v1 packages/workspace-infrastructure/sandbox-probe
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

ARG PROBE_BUILD_VERSION=dev
ENV PROBE_BUILD_VERSION=${PROBE_BUILD_VERSION} \
    NODE_ENV=production \
    PORT=8080

WORKDIR /probe
COPY probe.mjs server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
