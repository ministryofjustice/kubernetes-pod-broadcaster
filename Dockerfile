FROM denoland/deno:alpine

# The port that your application listens to.
EXPOSE 1993

WORKDIR /app

# Prefer not to run as root.
USER deno

# Copy the source files.
COPY ./deno* ./main* ./

# Compile the main app so that it doesn't need to be compiled each startup/entry.
RUN deno cache main.ts

CMD [ "task", "production" ]
