# --- Stage 1: Build dependencies ---
# Use the official Node.js 22 image as a base.
FROM node:22-alpine AS builder

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and the yarn.lock file to leverage Docker cache
COPY package.json yarn.lock ./

# Install production dependencies using yarn.
# --production skips devDependencies.
# --frozen-lockfile ensures we use the exact versions from yarn.lock.
RUN yarn install --production --frozen-lockfile

# --- Stage 2: Create the final, lean image ---
FROM node:22-alpine

WORKDIR /usr/src/app

# Copy the installed dependencies from the builder stage
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on
EXPOSE 3001

# The command to run your application
CMD [ "node", "server.js" ]