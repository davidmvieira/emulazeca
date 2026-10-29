FROM nginx:alpine
COPY index.html /usr/share/nginx/html/
# Se você criar um script.js separado, copie também:
# COPY script.js /usr/share/nginx/html/