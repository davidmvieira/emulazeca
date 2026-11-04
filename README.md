# emulazeca

## Lobby PostgreSQL

O serviço `romserver` cria a tabela `rooms` no PostgreSQL na inicialização. Antes
de subir o Compose, configure as credenciais do PostgreSQL no ambiente ou em um
arquivo `.env` local:

```env
PGUSER=seu_usuario
PGPASSWORD=sua_senha
PGDATABASE=seu_banco
```

O banco deve aceitar conexões TCP na porta `5432` da máquina host. O Compose
conecta ao host por `host.docker.internal`. O serviço salva as ROMs no volume
`roms_data`; a senha da sala é armazenada como hash e o host recebe um token
temporário para autorizar o kick.