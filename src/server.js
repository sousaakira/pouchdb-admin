const express = require('express');
const PouchDB = require('pouchdb');
const PouchDBAllDbs = require('pouchdb-all-dbs');
const path = require('path');
const fs = require('fs-extra');

const app = express();
const port = 3020;

// Caminho para o arquivo de registro dos bancos
const DB_REGISTRY_FILE = path.join(__dirname, 'db_registry.txt');

// Função para ler os bancos registrados
async function getRegisteredDatabases() {
    try {
        if (!await fs.exists(DB_REGISTRY_FILE)) {
            await fs.writeFile(DB_REGISTRY_FILE, '');
            return [];
        }
        const content = await fs.readFile(DB_REGISTRY_FILE, 'utf-8');
        return content.split('\n').filter(line => line.trim());
    } catch (error) {
        console.error('Erro ao ler registro de bancos:', error);
        return [];
    }
}

// Função para registrar novo banco
async function registerDatabase(name, path) {
    const entry = `${name}:${path}`;
    await fs.appendFile(DB_REGISTRY_FILE, entry + '\n');
}

// Função para registrar banco existente
async function registerExistingDatabase(name, dbPath) {
    try {
        // Garante que o diretório existe
        await fs.ensureDir(path.dirname(dbPath));
        
        // Tenta abrir o banco em modo somente leitura primeiro
        try {
            const db = new PouchDB(dbPath, {
                readonly: true,
                auto_compaction: false
            });
            await db.info(); // Testa se consegue acessar o banco
            await db.close();
        } catch (error) {
            // Se falhar em modo somente leitura, tenta abrir normalmente
            const db = new PouchDB(dbPath);
            await db.info();
            await db.close();
        }

        await registerDatabase(name, dbPath);
        return true;
    } catch (error) {
        console.error('Erro ao registrar banco:', error);
        throw new Error(`Erro ao registrar banco: ${error.message}`);
    }
}

// Função para verificar status do banco
async function checkDatabaseStatus(dbPath) {
    try {
        const lockFile = path.join(dbPath, 'LOCK');
        const isLocked = await fs.exists(lockFile);
        
        if (isLocked) {
            // Tenta abrir em modo somente leitura
            const db = new PouchDB(dbPath, {
                readonly: true,
                auto_compaction: false
            });
            await db.info();
            await db.close();
            return { status: 'locked', readable: true };
        }

        // Tenta abrir normalmente
        const db = new PouchDB(dbPath);
        await db.info();
        await db.close();
        return { status: 'available', readable: true };
    } catch (error) {
        return { status: 'error', readable: false, error: error.message };
    }
}

// Configurações
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Registrar o plugin
PouchDB.plugin(PouchDBAllDbs);
PouchDBAllDbs(PouchDB);

// Rota principal - Lista todos os bancos
app.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 5;
        const registeredDbs = await getRegisteredDatabases();
        
        const totalPages = Math.ceil(registeredDbs.length / limit);
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedDbs = registeredDbs.slice(startIndex, endIndex);
        
        // Verificar status de cada banco
        const databases = await Promise.all(paginatedDbs.map(async (db) => {
            const [name, dbPath] = db.split(':');
            const status = await checkDatabaseStatus(dbPath);
            return { 
                name, 
                path: dbPath, 
                isLocked: status.status === 'locked',
                isReadable: status.readable,
                statusMessage: status.status === 'locked' ? 
                    'Banco bloqueado (modo somente leitura)' : 
                    'Disponível'
            };
        }));

        res.render('index', { 
            databases,
            currentPage: page,
            totalPages,
            hasNextPage: endIndex < registeredDbs.length,
            hasPrevPage: page > 1
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rota para registrar banco existente
app.post('/database/register', async (req, res) => {
    const { name, dbPath } = req.body;
    try {
        // Valida os campos
        if (!name || !dbPath) {
            throw new Error('Nome e caminho do banco são obrigatórios');
        }
        
        // Resolve o caminho completo
        const fullPath = path.resolve(dbPath);
        await registerExistingDatabase(name, fullPath);
        res.redirect('/');
    } catch (error) {
        res.status(500).render('error', { error });
    }
});

// Rota para criar novo banco
app.post('/database/create', async (req, res) => {
    const { name, dbPath } = req.body;
    try {
        const fullPath = path.resolve(dbPath, name); // Combina o caminho com o nome
        const db = new PouchDB(fullPath);
        await db.info();
        await registerDatabase(name, fullPath);
        res.redirect('/');
    } catch (error) {
        res.status(500).render('error', { error });
    }
});

// Visualizar banco específico
app.get('/database/:name', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 50;
        const skip = (page - 1) * limit;

        const registeredDbs = await getRegisteredDatabases();
        const dbEntry = registeredDbs.find(db => db.split(':')[0] === req.params.name);
        
        if (!dbEntry) {
            throw new Error('Banco de dados não encontrado');
        }

        const [name, dbPath] = dbEntry.split(':');
        const status = await checkDatabaseStatus(dbPath);

        if (!status.readable) {
            throw new Error('Banco de dados inacessível');
        }

        const db = new PouchDB(dbPath, {
            readonly: status.status === 'locked'
        });
        
        const info = await db.info();
        const docs = await db.allDocs({ 
            include_docs: true,
            limit: limit,
            skip: skip
        });
        await db.close();

        const totalPages = Math.ceil(info.doc_count / limit);

        res.render('database', { 
            name, 
            info, 
            docs: docs.rows,
            currentPage: page,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
            isLocked: status.status === 'locked',
            statusMessage: status.status === 'locked' ? 
                'Banco bloqueado (modo somente leitura)' : 
                'Disponível'
        });
    } catch (error) {
        res.status(500).render('error', { error });
    }
});

// Deletar banco
app.post('/database/:name/delete', async (req, res) => {
    try {
        const registeredDbs = await getRegisteredDatabases();
        const dbEntry = registeredDbs.find(db => db.split(':')[0] === req.params.name);
        
        if (!dbEntry) {
            throw new Error('Banco de dados não encontrado');
        }

        const [name, dbPath] = dbEntry.split(':');
        const db = new PouchDB(dbPath);
        await db.destroy();

        // Remove o banco do registro
        const updatedDbs = registeredDbs.filter(db => db.split(':')[0] !== name);
        await fs.writeFile(DB_REGISTRY_FILE, updatedDbs.join('\n') + (updatedDbs.length ? '\n' : ''));
        
        res.redirect('/');
    } catch (error) {
        res.status(500).render('error', { error });
    }
});

// Rota para desregistrar banco (sem deletar)
app.post('/database/:name/unregister', async (req, res) => {
    try {
        const registeredDbs = await getRegisteredDatabases();
        const dbEntry = registeredDbs.find(db => db.split(':')[0] === req.params.name);
        
        if (!dbEntry) {
            throw new Error('Banco de dados não encontrado');
        }

        // Remove apenas do registro, sem deletar o banco
        const updatedDbs = registeredDbs.filter(db => db.split(':')[0] !== req.params.name);
        await fs.writeFile(DB_REGISTRY_FILE, updatedDbs.join('\n') + (updatedDbs.length ? '\n' : ''));
        
        res.redirect('/');
    } catch (error) {
        res.status(500).render('error', { error });
    }
});

// Rota para deletar documento
app.post('/database/:dbName/doc/:docId/delete', async (req, res) => {
    try {
        const registeredDbs = await getRegisteredDatabases();
        const dbEntry = registeredDbs.find(db => db.split(':')[0] === req.params.dbName);
        
        if (!dbEntry) {
            throw new Error('Banco de dados não encontrado');
        }

        const [name, dbPath] = dbEntry.split(':');
        const db = new PouchDB(dbPath);
        
        // Busca o documento atual para pegar o _rev
        const doc = await db.get(req.params.docId);
        await db.remove(doc);
        
        res.redirect(`/database/${name}`);
    } catch (error) {
        res.status(500).render('error', { error });
    }
});

// Rota para exibir formulário de edição
app.get('/database/:dbName/doc/:docId/edit', async (req, res) => {
    try {
        const registeredDbs = await getRegisteredDatabases();
        const dbEntry = registeredDbs.find(db => db.split(':')[0] === req.params.dbName);
        
        if (!dbEntry) {
            throw new Error('Banco de dados não encontrado');
        }

        const [name, dbPath] = dbEntry.split(':');
        const db = new PouchDB(dbPath);
        const doc = await db.get(req.params.docId);
        
        res.render('edit_document', { dbName: name, doc });
    } catch (error) {
        res.status(500).render('error', { error });
    }
});

// Rota para atualizar documento
app.post('/database/:dbName/doc/:docId/update', async (req, res) => {
    try {
        const registeredDbs = await getRegisteredDatabases();
        const dbEntry = registeredDbs.find(db => db.split(':')[0] === req.params.dbName);
        
        if (!dbEntry) {
            throw new Error('Banco de dados não encontrado');
        }

        const [name, dbPath] = dbEntry.split(':');
        const db = new PouchDB(dbPath);
        
        // Busca o documento atual para manter o _rev
        const currentDoc = await db.get(req.params.docId);
        
        // Atualiza o documento mantendo o _id e _rev
        const updatedDoc = {
            ...JSON.parse(req.body.content),
            _id: currentDoc._id,
            _rev: currentDoc._rev
        };
        
        await db.put(updatedDoc);
        res.redirect(`/database/${name}`);
    } catch (error) {
        res.status(500).render('error', { error });
    }
});

// Rota para exibir formulário de criação de documento
app.get('/database/:dbName/doc/new', async (req, res) => {
    try {
        const registeredDbs = await getRegisteredDatabases();
        const dbEntry = registeredDbs.find(db => db.split(':')[0] === req.params.dbName);
        
        if (!dbEntry) {
            throw new Error('Banco de dados não encontrado');
        }

        const [name] = dbEntry.split(':');
        // Template inicial para novo documento
        const doc = {
            _id: '', // Será preenchido pelo usuário
            // Adicione aqui outros campos padrão se desejar
        };
        
        res.render('new_document', { dbName: name, doc });
    } catch (error) {
        res.status(500).render('error', { error });
    }
});

// Rota para criar novo documento
app.post('/database/:dbName/doc/create', async (req, res) => {
    try {
        const registeredDbs = await getRegisteredDatabases();
        const dbEntry = registeredDbs.find(db => db.split(':')[0] === req.params.dbName);
        
        if (!dbEntry) {
            throw new Error('Banco de dados não encontrado');
        }

        const [name, dbPath] = dbEntry.split(':');
        const db = new PouchDB(dbPath);
        
        const newDoc = JSON.parse(req.body.content);
        await db.put(newDoc);
        
        res.redirect(`/database/${name}`);
    } catch (error) {
        res.status(500).render('error', { error });
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
}); 