FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g @earendil-works/pi-coding-agent@1.6.1
RUN useradd --create-home --uid 10001 course && mkdir /work && chown course:course /work
# unzip for course zips (2026-11-26). A separate layer, so the layers above stay cached.
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
USER course
WORKDIR /work
CMD ["sleep", "infinity"]
