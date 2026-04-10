FROM denoland/deno:alpine

# The port that your application listens to.
EXPOSE 1993

WORKDIR /app

# Upgrade vulnerable Alpine packages shipped in the base image.
# Fixes vuln. in zlib <1.3.2-r0
# See: https://security.snyk.io/vuln/SNYK-ALPINE323-ZLIB-15435529
RUN apk add --no-cache --upgrade zlib apk-tools libapk

# Prefer not to run as root.
USER deno

# Copy the source files.
COPY --chown=deno:deno ./deno* ./main* ./

# Compile the main app so that it doesn't need to be compiled each startup/entry.
RUN deno cache main.ts

# Prevent Deno from checking for updates to the Deno CLI.
ENV DENO_NO_UPDATE_CHECK=1

CMD [ "task", "production" ]
