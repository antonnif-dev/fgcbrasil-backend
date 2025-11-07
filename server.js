require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// --- Configuração do Firebase Admin ---
try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  }
  else {
    throw new Error("Credenciais do Firebase Admin SDK não encontradas. Defina FIREBASE_SERVICE_ACCOUNT_JSON (no Render) ou FIREBASE_SERVICE_ACCOUNT_PATH (local).");
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });  
  console.log("Firebase Admin SDK inicializado com sucesso.");
} catch (error) {
  console.error("Erro ao inicializar Firebase Admin SDK:", error.message);
  process.exit(1);
}
const db = admin.firestore();
const auth = admin.auth();
const app = express();

// --- Middlewares ---
app.use(cors()); 
app.use(express.json()); 

// Lógica de Distribuição de XP
const XP_DISTRIBUTION = {
  1: 0.660, 2: 0.300, 3: 0.240, 4: 0.220, 5: 0.210, 
  6: 0.205, 7: 0.202, 8: 0.200, 9: 0.100, 
};

// Middleware de autenticação
const checkAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).send({ error: 'Não autorizado: Token não fornecido' });

  try {
    const decodedToken = await auth.verifyIdToken(token);
    req.user = decodedToken; // Adiciona infos do token (uid, email, admin claim)
    
    // --- NOVO: Anexa dados do Firestore (como organizacaoId) ao req.user ---
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    if (userDoc.exists) {
      req.user.data = userDoc.data(); // req.user.data.tipo, req.user.data.organizacaoId
    }
    
    next();
  } catch (error) {
    return res.status(401).send({ error: 'Não autorizado: Token inválido' });
  }
};

// Middleware para verificar se é Admin (Admin Global ou Organizador)
const checkAdmin = async (req, res, next) => {
  // Permite se for Admin Global (do setup-admin) OU um Organizador
  if (req.user.admin === true || req.user.data?.tipo === 'organizador') {
    next();
  } else {
    return res.status(403).send({ error: 'Proibido: Acesso restrito a administradores' });
  }
};

const checkGlobalAdmin = async (req, res, next) => {
  // Apenas permite 'admin: true' (do setup-admin) e que o tipo seja 'admin'
  if (req.user.admin === true && req.user.data?.tipo === 'admin') {
    next();
  } else {
    return res.status(403).send({ error: 'Proibido: Acesso restrito a administradores globais' });
  }
};


// --- Rotas ---

// [PÚBLICA] Teste de API
app.get('/api', (req, res) => {
  res.send({ message: 'API FGC Brasil funcionando!' });
});

// --- (SUBSTITUA A ROTA /api/users/register) ---
app.post('/api/users/register', async (req, res) => {
  const { uid, email, nome, tipo } = req.body;
  
  if (!uid || !email || !nome || !tipo) {
    return res.status(400).send({ error: 'Dados incompletos para registro' });
  }
  
  const batch = db.batch();
  
  try {
    const userRef = db.collection('users').doc(uid);
    let organizacaoId = null;

    if (tipo === 'organizador') {
      const orgRef = db.collection('organizacoes').doc(); 
      organizacaoId = orgRef.id;
      
      batch.set(orgRef, {
        id: organizacaoId,
        nome: nome, 
        descricao: `Organização de ${nome}`,
        adminUserId: uid,
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
        xpBase: 1000,
        imagemUrl: '',
      });
      
      await auth.setCustomUserClaims(uid, { admin: true });
      
    } else if (tipo === 'admin') {
       await auth.setCustomUserClaims(uid, { admin: true });
    }

    batch.set(userRef, {
      id: uid,
      email,
      nome,
      tipo,
      organizacaoId: organizacaoId, 
      xpTotal: 0,
      campeonatosParticipados: [],
      contribuicoes: [],
      missoesCompletas: [],
      // --- CAMPOS ADICIONADOS ---
      profileImageUrl: '', // URL da foto de perfil
      teamName: '',        // Nome da equipe (para jogadores)
      // --- FIM ---
      criadoEm: admin.firestore.FieldValue.serverTimestamp()
    });
    
    await batch.commit();
    
    res.status(201).send({ id: uid, message: 'Usuário registrado com sucesso' });
  } catch (error) {
    res.status(500).send({ error: 'Erro ao registrar usuário', details: error.message });
  }
});

// [ADMIN] Rota de Setup (Admin Global) - (Sem mudanças)
app.post('/api/users/setup-admin', async (req, res) => {
  // (mantenha o código da rota setup-admin que você já tem)
  const { email } = req.body;
  try {
    const user = await auth.getUserByEmail(email);
    await auth.setCustomUserClaims(user.uid, { admin: true });
    await db.collection('users').doc(user.uid).update({ 
      admin: true,
      tipo: 'admin' // Define o tipo como admin global
    });
    res.status(200).send({ message: `Sucesso! Usuário ${email} agora é um Admin Global.` });
  } catch (error) {
    res.status(500).send({ error: 'Erro ao definir admin', details: error.message });
  }
});


// --- NOVAS ROTAS DE LEITURA ---

// [PÚBLICA] Retorna todas as organizações (para a nova pág de campeonatos)
app.get('/api/organizacoes', async (req, res) => {
  try {
    const snapshot = await db.collection('organizacoes').orderBy('nome', 'asc').get();
    const orgs = snapshot.docs.map(doc => doc.data());
    res.status(200).send(orgs);
  } catch (error) {
    res.status(500).send({ error: 'Erro ao buscar organizações', details: error.message });
  }
});

// [PÚBLICA] Retorna todos os campeonatos de UMA organização (para o modal)
/*-------
app.get('/api/organizacoes/:id/championships', async (req, res) => {
  const orgId = req.params.id;
  try {
    const snapshot = await db.collection('championships')
      .where('organizadorId', '==', orgId)
      .orderBy('data', 'desc')
      .get();
      
    const champs = snapshot.docs.map(doc => doc.data());
    res.status(200).send(champs);
  } catch (error) {
    res.status(500).send({ error: 'Erro ao buscar campeonatos da organização', details: error.message });
  }
});
*/
// [PÚBLICA] Retorna todos os campeonatos de UMA organização (para o modal)
app.get('/api/organizacoes/:id/championships', async (req, res) => {
  const orgId = req.params.id;
  try {
    const snapshot = await db.collection('championships')
      .where('organizadorId', '==', orgId)
      .orderBy('data', 'desc')
      .get();
      
    // --- MUDANÇA AQUI ---
    // Precisamos converter o Timestamp manualmente
    const champs = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        ...data,
        // Converte o Timestamp do Firestore (se existir) para uma string ISO
        // que o new Date() do frontend consegue ler.
        data: data.data?.toDate ? data.data.toDate().toISOString() : data.data
      };
    });
    // --- FIM DA MUDANÇA ---
    
    res.status(200).send(champs);
  } catch (error) {
    // Adiciona o log de erro aqui, caso seja o índice
    console.error("--- ERRO AO BUSCAR CAMPEONATOS DA ORG (ÍNDICE FALTANDO?) ---");
    console.error(error);
    res.status(500).send({ error: 'Erro ao buscar campeonatos da organização', details: error.message });
  }
});

//Criar campeonato
app.post('/api/championships', checkAuth, checkAdmin, async (req, res) => {
  // 'game' (o slug, ex: "sf6") agora é recebido
  const { nome, descricao, data, xpTotal: xpOverride, organizadorId, game } = req.body;
  const adminUser = req.user.data; 
  const adminId = req.user.uid; 

  let orgIdParaUsar = null;
  
  if (adminUser.tipo === 'organizador') {
    orgIdParaUsar = adminUser.organizacaoId;
  } else if (adminUser.admin === true) {
    orgIdParaUsar = organizadorId;
  }

  if (!orgIdParaUsar) {
    return res.status(403).send({ error: 'Você não tem um ID de organização válido.' });
  }
  
  try {
    const orgRef = db.collection('organizacoes').doc(orgIdParaUsar);
    const champRef = db.collection('championships').doc();

    // Usamos uma transação para garantir que ambos os documentos sejam atualizados
    await db.runTransaction(async (transaction) => {
      const orgDoc = await transaction.get(orgRef);
      if (!orgDoc.exists) {
        throw new Error('Organização selecionada não foi encontrada.');
      }
      
      const orgData = orgDoc.data();
      const organizadorNome = orgData.nome;

      let xpFinalParaUsar = Number(xpOverride) || 0; 
      if (xpFinalParaUsar <= 0) {
        xpFinalParaUsar = orgData.xpBase || 1000; 
      }

      // 1. Cria o novo campeonato
      transaction.set(champRef, {
        id: champRef.id,
        organizadorId: orgIdParaUsar,
        organizadorNome: organizadorNome,
        nome,
        descricao,
        game: game || null, // <-- CAMPO ADICIONADO (salva o slug 'sf6')
        data: admin.firestore.Timestamp.fromDate(new Date(data)),
        xpTotal: xpFinalParaUsar, 
        participantes: [],
        criadoPor: adminId,
        status: "aberto",
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // 2. Atualiza a organização com o novo "slug" do jogo (se ele existir)
      if (game) {
        transaction.update(orgRef, {
          games: admin.firestore.FieldValue.arrayUnion(game) // Adiciona o slug ao array 'games'
        });
      }
    });
    
    res.status(201).send({ id: champRef.id, message: 'Campeonato criado' });
    
  } catch (error) {
    console.error("Erro ao criar campeonato:", error);
    res.status(500).send({ error: 'Erro ao criar campeonato', details: error.message });
  }
});

// [FÃ] Doação de Fã (Sem mudanças)
app.post('/api/contributions', checkAuth, async (req, res) => {
  // ... (mantenha o código original de /api/contributions)
  const fanId = req.user.uid;
  const { valor } = req.body;
  const xpGerado = Math.floor(valor * 10); 
  try {
    const userRef = db.collection('users').doc(fanId);
    const contributionRef = db.collection('contributions').doc();
    await contributionRef.set({ id: contributionRef.id, fanId, valor, xpGerado, data: admin.firestore.FieldValue.serverTimestamp() });
    await userRef.update({
      xpTotal: admin.firestore.FieldValue.increment(xpGerado),
      contribuicoes: admin.firestore.FieldValue.arrayUnion(contributionRef.id)
    });
    res.status(201).send({ message: `Obrigado pela doação! Você ganhou ${xpGerado} XP.`, id: contributionRef.id });
  } catch (error) {
    res.status(500).send({ error: 'Erro ao processar doação', details: error.message });
  }
});

// [ADMIN] Registrar patrocínio
app.post('/api/donations', checkAuth, checkAdmin, async (req, res) => {
    // tipo: 'corporate' ou 'fan'
    const { tipo, patrocinador, fanId, valorTotal, atividade, xpOferecido } = req.body;
    
    let nomePatrocinador = patrocinador;
    let batch = db.batch(); // Usar batch para a atualização de XP

    try {
        // Se for um bônus para um fã, precisamos buscar o nome e dar o XP
        if (tipo === 'fan') {
          if (!fanId) return res.status(400).send({ error: 'ID do Fã é obrigatório.' });
          
          const userRef = db.collection('users').doc(fanId);
          const userDoc = await userRef.get();
          
          if (!userDoc.exists || userDoc.data().tipo !== 'fã') {
            return res.status(404).send({ error: 'Usuário Fã não encontrado.' });
          }
          
          nomePatrocinador = userDoc.data().nome; // O "patrocinador" é o fã
          
          // Se houver XP, adiciona ao fã
          if (xpOferecido > 0) {
            batch.update(userRef, {
              xpTotal: admin.firestore.FieldValue.increment(Number(xpOferecido))
            });
          }
        }

        // Se for corporativo, o nomePatrocinador já veio do body
        if (!nomePatrocinador) {
           return res.status(400).send({ error: 'Nome do patrocinador ou Fã é obrigatório.' });
        }

        const donationRef = db.collection('donations').doc();
        batch.set(donationRef, {
            id: donationRef.id,
            patrocinador: nomePatrocinador, // Salva o nome (da empresa ou do fã)
            fanId: tipo === 'fan' ? fanId : null, // Guarda o ID se for um fã
            valorTotal,
            atividade,
            xpOferecido,
            data: admin.firestore.FieldValue.serverTimestamp()
        });
        
        await batch.commit(); // Salva o documento de doação E atualiza o XP do fã (se aplicável)
        
        let message = `Patrocínio de "${nomePatrocinador}" registrado.`;
        if(tipo === 'fan' && xpOferecido > 0) {
          message += ` ${nomePatrocinador} recebeu ${xpOferecido} XP!`;
        }

        res.status(201).send({ id: donationRef.id, message: message });
    } catch (error) {
        res.status(500).send({ error: 'Erro ao registrar patrocínio', details: error.message });
    }
});

// [PÚBLICA] Busca a rifa ativa
app.get('/api/rifa/atual', async (req, res) => {
  try {
    // Vamos assumir que a rifa ativa sempre terá o ID "atual"
    const rifaRef = db.collection('rifas').doc('atual');
    const doc = await rifaRef.get();
    
    if (!doc.exists) {
      return res.status(404).send({ error: 'Nenhuma rifa ativa encontrada.' });
    }
    
    res.status(200).send(doc.data());
  } catch (error) {
    res.status(500).send({ error: 'Erro ao buscar rifa', details: error.message });
  }
});

// [PÚBLICA] Busca todas as missões disponíveis
app.get('/api/missions', async (req, res) => {
  try {
    const snapshot = await db.collection('missoes').get();
    const missions = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    res.status(200).send(missions);
  } catch (error) {
    res.status(500).send({ error: 'Erro ao buscar missões', details: error.message });
  }
});

// [USUÁRIO LOGADO] Completa uma missão
app.post('/api/missions/complete', checkAuth, async (req, res) => {
  const { missionId } = req.body;
  const userId = req.user.uid;
  const userData = req.user.data; // Dados do Firestore

  if (!missionId) {
    return res.status(400).send({ error: 'ID da missão é obrigatório.' });
  }

  try {
    // 1. Verifica se a missão já foi completada
    if (userData.missoesCompletas && userData.missoesCompletas.includes(missionId)) {
      return res.status(400).send({ error: 'Missão já completada.' });
    }

    // 2. Busca a missão para saber o XP
    const missionRef = db.collection('missoes').doc(missionId);
    const missionDoc = await missionRef.get();
    
    if (!missionDoc.exists) {
      return res.status(404).send({ error: 'Missão não encontrada.' });
    }
    
    const xpRecompensa = missionDoc.data().xpRecompensa || 0;

    // 3. Atualiza o usuário
    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      xpTotal: admin.firestore.FieldValue.increment(xpRecompensa),
      missoesCompletas: admin.firestore.FieldValue.arrayUnion(missionId)
    });

    res.status(200).send({ message: `Missão completada! Você ganhou ${xpRecompensa} XP!` });

  } catch (error) {
    res.status(500).send({ error: 'Erro ao completar missão', details: error.message });
  }
});

// [ADMIN GLOBAL] Adiciona um participante à rifa
app.post('/api/rifa/add-participante', checkAuth, checkGlobalAdmin, async (req, res) => {
  const { jogadorId } = req.body;
  
  if (!jogadorId) {
    return res.status(400).send({ error: 'ID do jogador é obrigatório.' });
  }
  
  try {
    const rifaRef = db.collection('rifas').doc('atual');
    
    // --- CORREÇÃO AQUI ---
    // 1. Get the user from Firestore
    const userDocRef = db.collection('users').doc(jogadorId);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
        return res.status(404).send({ error: 'Usuário não encontrado no Firestore.' });
    }
    
    // 2. Get the correct name from the Firestore document
    const nome = userDoc.data().nome; // <-- Pega o nome do documento 'users'
    // --- FIM DA CORREÇÃO ---

    if (!nome) {
      // Caso de fallback (raro), se o documento 'users' não tiver nome
      const userRecord = await auth.getUser(jogadorId);
      nome = userRecord.email; 
    }
    
    // Lógica de auto-incremento (transacional para segurança)
    const numeroDaCota = await db.runTransaction(async (transaction) => {
      const rifaDoc = await transaction.get(rifaRef);
      if (!rifaDoc.exists) {
        throw new Error("Documento da rifa 'atual' não existe!");
      }
      
      const participantes = rifaDoc.data().participantes || [];
      
      let maxNumero = 0;
      participantes.forEach(p => {
        if (p.numero > maxNumero) {
          maxNumero = p.numero;
        }
      });
      
      const proximoNumero = maxNumero + 1;
      
      transaction.update(rifaRef, {
        participantes: admin.firestore.FieldValue.arrayUnion({
          numero: proximoNumero,
          nome: nome, // <-- AGORA ESTÁ SALVANDO O NOME CORRETO
          id: jogadorId 
        })
      });
      
      return proximoNumero;
    });

    res.status(200).send({ message: `Participante ${nome} adicionado ao número ${numeroDaCota}!` });
  } catch (error) {
    console.error("Erro ao adicionar participante:", error);
    res.status(500).send({ error: 'Erro ao adicionar participante', details: error.message });
  }
});

// [USUÁRIO LOGADO] Envia um ticket de suporte para a administração
app.post('/api/support/send-ticket', checkAuth, async (req, res) => {
  const { subject, message } = req.body;
  const { uid, email } = req.user; // Pego do checkAuth (token)
  const nome = req.user.data?.nome; // Pego do checkAuth (dados do Firestore)

  if (!subject || !message) {
    return res.status(400).send({ error: 'Assunto e Mensagem são obrigatórios.' });
  }

  try {
    const ticketRef = db.collection('suporteTickets').doc(); // Nova coleção
    
    await ticketRef.set({
      id: ticketRef.id,
      userId: uid,
      nome: nome || email, // Identificação do usuário (Nome, ou Email se não houver nome)
      email: email,
      assunto: subject,
      mensagem: message,
      status: 'aberto', // Para controle futuro
      criadoEm: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(201).send({ message: 'Mensagem enviada com sucesso! A administração responderá em breve.' });
  } catch (error) {
    console.error("Erro ao enviar ticket de suporte:", error);
    res.status(500).send({ error: 'Erro ao enviar mensagem', details: error.message });
  }
});

// [PÚBLICA] Retorna o ranking de jogadores
app.get('/api/ranking', async (req, res) => {
  try {
    // Query 1: Busca os Jogadores
    const playerQuery = db.collection('users')
      .where('tipo', '==', 'jogador')
      .orderBy('xpTotal', 'desc')
      .limit(100)
      .get();
      
    // Query 2: Busca os Fãs
    const fanQuery = db.collection('users')
      .where('tipo', '==', 'fã')
      .orderBy('xpTotal', 'desc')
      .limit(100)
      .get();

    const [playerSnapshot, fanSnapshot] = await Promise.all([playerQuery, fanQuery]);

    // Processa o ranking de Jogadores
    let playerPos = 1;
    const players = playerSnapshot.docs.map(doc => {
      const data = doc.data();
      return { 
        posicao: playerPos++, 
        jogadorId: data.id, 
        nome: data.nome, 
        xpTotal: data.xpTotal,
        profileImageUrl: data.profileImageUrl || '' // <-- CAMPO ADICIONADO
      };
    });
    
    // Processa o ranking de Fãs
    let fanPos = 1;
    const fans = fanSnapshot.docs.map(doc => {
      const data = doc.data();
      return { 
        posicao: fanPos++, 
        jogadorId: data.id, 
        nome: data.nome, 
        xpTotal: data.xpTotal,
        profileImageUrl: data.profileImageUrl || '' // <-- CAMPO ADICIONADO
      };
    });
    
    res.status(200).send({ players: players, fans: fans });
    
  } catch (error) {
    console.error("--- ERRO AO GERAR RANKING ---");
    console.error(error);
    console.error("-------------------------------");
    res.status(500).send({ error: 'Erro ao gerar ranking', details: error.message });
  }
});

// [PÚBLICA] Busca as configurações de ranking (XP Mínimo)
app.get('/api/config/ranking', async (req, res) => {
  try {
    // Usamos uma coleção 'configuracoes' e um doc 'ranking'
    const configRef = db.collection('configuracoes').doc('ranking');
    const doc = await configRef.get();
    
    if (!doc.exists) {
      // Se não existir, retorna valores padrão
      return res.status(200).send({ minXpJogadores: 500, minXpFas: 100 });
    }
    
    res.status(200).send(doc.data());
  } catch (error) {
    res.status(500).send({ error: 'Erro ao buscar configurações do ranking', details: error.message });
  }
});

// [ADMIN GLOBAL] Atualiza as configurações de ranking (XP Mínimo)
app.post('/api/config/ranking', checkAuth, checkGlobalAdmin, async (req, res) => {
  const { minXpJogadores, minXpFas } = req.body;
  
  if (minXpJogadores === undefined || minXpFas === undefined) {
    return res.status(400).send({ error: 'Valores de XP mínimo são obrigatórios.' });
  }

  try {
    const configRef = db.collection('configuracoes').doc('ranking');
    
    // Use .set() com { merge: true } para criar ou atualizar o documento
    await configRef.set({
      minXpJogadores: Number(minXpJogadores),
      minXpFas: Number(minXpFas)
    }, { merge: true });
    
    res.status(200).send({ message: 'Configurações do ranking salvas com sucesso!' });
  } catch (error) {
    res.status(500).send({ error: 'Erro ao salvar configurações', details: error.message });
  }
});

// [ADMIN] Lista TODOS os usuários (para o seletor da rifa)
app.get('/api/users/all', checkAuth, checkGlobalAdmin, async (req, res) => {
  try {
    // CORREÇÃO: Busca da coleção 'users' (Firestore) em vez do 'auth'
    const snapshot = await db.collection('users').orderBy('nome', 'asc').get();
    
    const users = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        nome: data.nome || data.email, // Pega o NOME CORRETO do Firestore
      };
    });
    
    res.status(200).send(users);
  } catch (error) {
    res.status(500).send({ error: 'Erro ao buscar todos os usuários', details: error.message });
  }
});

// [ADMIN GLOBAL] Reseta (limpa) as cotas da rifa atual
app.delete('/api/rifa/reset', checkAuth, checkGlobalAdmin, async (req, res) => {
  try {
    const rifaRef = db.collection('rifas').doc('atual');
    
    // Define o array 'participantes' como um array vazio
    await rifaRef.update({
      participantes: [] 
    });
    
    res.status(200).send({ message: 'Rifa resetada com sucesso!' });
  } catch (error) {
    res.status(500).send({ error: 'Erro ao resetar rifa', details: error.message });
  }
});

// [ADMIN] Listar todos os usuários do tipo 'fã/espectadores'
app.get('/api/fans', checkAuth, checkAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('users')
      .where('tipo', '==', 'fã')
      .orderBy('nome', 'asc')
      .get();
      
    const fans = snapshot.docs.map(doc => ({ 
      id: doc.id, 
      nome: doc.data().nome 
    }));
    
    res.status(200).send(fans);
  } catch (error) {
    // --- MUDANÇA ---
    console.error("--- ERRO AO BUSCAR FÃS (ÍNDICE FALTANDO?) ---");
    console.error(error);
    // --- FIM DA MUDANÇA ---
    res.status(500).send({ error: 'Erro ao buscar fãs', details: error.message });
  }
});

// [ADMIN] Listar todos os jogadores
app.get('/api/players', checkAuth, checkAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('users')
      .where('tipo', '==', 'jogador')
      .orderBy('nome', 'asc')
      .get();
    const players = snapshot.docs.map(doc => ({ id: doc.id, nome: doc.data().nome }));
    res.status(200).send(players);
  } catch (error) {
    // --- MOSTRA O ERRO DE ÍNDICE NO TERMINAL ---
    console.error("--- ERRO AO BUSCAR 'PLAYERS' (ÍNDICE FALTANDO?) ---");
    console.error(error);
    res.status(500).send({ error: 'Erro ao buscar jogadores', details: error.message });
  }
});

// [PÚBLICA] Retorna o total de contribuições de fãs (para o novo card)
app.get('/api/contributions/total', async (req, res) => {
  try {
    const snapshot = await db.collection('contributions').get();
    let totalValor = 0;
    
    // Soma o campo 'valor' de todos os documentos
    snapshot.docs.forEach(doc => {
      totalValor += doc.data().valor || 0;
    });
    
    res.status(200).send({ total: totalValor });
  } catch (error) {
    res.status(500).send({ error: 'Erro ao buscar total de contribuições', details: error.message });
  }
});

// --- NOVO: Rota para admin buscar SÓ OS SEUS campeonatos ---
app.get('/api/admin/my-championships', checkAuth, checkAdmin, async (req, res) => {
  let orgId = req.user.data.organizacaoId;
  let query;

  if (req.user.data.tipo === 'admin' && req.user.admin === true) {
    query = db.collection('championships').orderBy('data', 'desc');
  } 
  else if (req.user.data.tipo === 'organizador' && orgId) {
    query = db.collection('championships').where('organizadorId', '==', orgId).orderBy('data', 'desc');
  } else {
    return res.status(403).send({ error: 'Usuário não tem permissão para esta ação.' });
  }
  
  try {
    const snapshot = await query.get();
    const champs = snapshot.docs.map(doc => doc.data());
    res.status(200).send(champs);
  } catch (error) {
     // --- MOSTRA O ERRO DE ÍNDICE NO TERMINAL ---
     console.error("--- ERRO AO BUSCAR 'MY-CHAMPIONSHIPS' (ÍNDICE FALTANDO?) ---");
     console.error(error);
     res.status(500).send({ error: 'Erro ao buscar seus campeonatos', details: error.message });
  }
});

app.post('/api/admin/championships/:id/finalize', checkAuth, checkAdmin, async (req, res) => {
  const champId = req.params.id;
  // O body agora envia: { jogadorId, nomeManual, posicao }
  const { top8, participation } = req.body;
  let xpDistributed = 0; 
  
  try {
    const champRef = db.collection('championships').doc(champId);
    
    await db.runTransaction(async (transaction) => {
      const champDoc = await transaction.get(champRef);
      if (!champDoc.exists) throw new Error('Campeonato não encontrado');
      const champData = champDoc.data();
      if (champData.status === 'finalizado') throw new Error('Este campeonato já foi finalizado.');

      const isGlobalAdmin = req.user.data?.tipo === 'admin' && req.user.admin === true;
      const isOwner = champData.organizadorId === req.user.data?.organizacaoId;
      if (!isGlobalAdmin && !isOwner) throw new Error('Você não tem permissão para finalizar este campeonato.');

      const xpTotalCampeonato = champData.xpTotal; 
      const playerUpdates = []; // Lista de jogadores a receber XP
      let updates = []; // Lista de todos os resultados para salvar no campeonato
      
      if (top8 && top8.length > 0) {
        for (const player of top8) {
          const { jogadorId, nomeManual, posicao } = player;
          const pos = parseInt(posicao, 10);
          
          // Se for um JOGADOR REGISTRADO (tem ID)
          if (jogadorId) {
            const xpPercent = XP_DISTRIBUTION[pos]; 
            if (xpPercent) {
              const xpGanho = xpTotalCampeonato * xpPercent;
              // Adiciona à lista para buscar o nome e dar XP
              playerUpdates.push({ id: jogadorId, pos: pos, xp: xpGanho });
            }
          } 
          // Se for um JOGADOR MANUAL (sem ID)
          else if (nomeManual) {
            // Salva o resultado no campeonato com 0 XP
            updates.push({ jogadorId: null, posicao: pos, xpGanho: 0, nome: nomeManual });
          }
        }
      }
      
      // (A lógica de 'participation' (9º+) continua a mesma, pois não-cadastrados não devem ganhar XP de participação)
      if (participation && participation.length > 0) {
        const xpGanho = xpTotalCampeonato * XP_DISTRIBUTION[9]; 
        for (const jogadorId of participation) {
          if (!jogadorId) continue; 
          playerUpdates.push({ id: jogadorId, pos: 9, xp: xpGanho });
        }
      }
      
      // --- ETAPA 1.5: LEITURA dos Nomes (Apenas para jogadores registrados) ---
      const userRefs = playerUpdates.map(p => db.collection('users').doc(p.id));
      const userDocs = userRefs.length > 0 ? await transaction.getAll(...userRefs) : [];
      const userMap = {}; 
      userDocs.forEach(doc => {
        if (doc.exists) userMap[doc.id] = doc.data().nome;
      });

      // --- ETAPA 2: ESCRITA (Writes) ---
      for (const p of playerUpdates) {
        const nomeJogador = userMap[p.id] || 'Jogador Desconhecido';
        const userRef = db.collection('users').doc(p.id);
        
        transaction.update(userRef, { 
          xpTotal: admin.firestore.FieldValue.increment(p.xp), 
          campeonatosParticipados: admin.firestore.FieldValue.arrayUnion(champId) 
        });
        
        updates.push({ jogadorId: p.id, posicao: p.pos, xpGanho: p.xp, nome: nomeJogador });
        xpDistributed += p.xp;
      }
      
      if (updates.length > 0) {
        transaction.update(champRef, { 
          participantes: admin.firestore.FieldValue.arrayUnion(...updates),
          status: "finalizado"
        });
      } else {
        transaction.update(champRef, { status: "finalizado" });
      }
    });

    res.status(200).send({ message: `Campeonato finalizado! Total de ${xpDistributed.toFixed(2)} XP distribuído.` });
  
  } catch (error) {
    console.error("Erro ao finalizar campeonato (padrão):", error);
    res.status(500).send({ error: 'Erro ao finalizar campeonato', details: error.message });
  }
});

app.post('/api/admin/championships/:id/finalize-custom', checkAuth, checkAdmin, async (req, res) => {
  const champId = req.params.id;
  const { top8, participation } = req.body; 
  let xpDistributed = 0; 

  try {
    const champRef = db.collection('championships').doc(champId);

    await db.runTransaction(async (transaction) => {
      // --- ETAPA 1: LEITURA (Reads) ---
      const champDoc = await transaction.get(champRef);
      if (!champDoc.exists) throw new Error('Campeonato não encontrado');

      const champData = champDoc.data();
      if (champData.status === 'finalizado') throw new Error('Este campeonato já foi finalizado.');

      const isGlobalAdmin = req.user.data?.tipo === 'admin' && req.user.admin === true;
      const isOwner = champData.organizadorId === req.user.data?.organizacaoId;
      if (!isGlobalAdmin && !isOwner) throw new Error('Você não tem permissão para finalizar este campeonato.');

      const playerUpdates = []; // Lista de jogadores a receber XP
      let updates = []; // Lista de todos os resultados para salvar no campeonato
      
      if (top8 && top8.length > 0) {
        for (const player of top8) {
          const { jogadorId, nomeManual, posicao, xpGanho } = player;
          
          // Se for um JOGADOR REGISTRADO (tem ID e XP)
          if (jogadorId && xpGanho > 0) {
            playerUpdates.push({ id: jogadorId, pos: posicao, xp: Number(xpGanho) });
          }
          // Se for um JOGADOR MANUAL (sem ID)
          else if (nomeManual) {
            updates.push({ jogadorId: null, posicao: posicao, xpGanho: 0, nome: nomeManual });
          }
        }
      }
      
      // Lógica de Participação (9º+)
      if (participation && participation.jogadorIds.length > 0 && participation.xpGanho > 0) {
        const xpNum = Number(participation.xpGanho);
        for (const jogadorId of participation.jogadorIds) {
          if (!jogadorId) continue; 
          playerUpdates.push({ id: jogadorId, pos: 9, xp: xpNum });
        }
      }

      // LEIA todos os nomes de jogador de uma vez
      const userRefs = playerUpdates.map(p => db.collection('users').doc(p.id));
      const userDocs = userRefs.length > 0 ? await transaction.getAll(...userRefs) : [];
      const userMap = {};
      userDocs.forEach(doc => {
        if (doc.exists) userMap[doc.id] = doc.data().nome;
      });

      // --- ETAPA 2: ESCRITA (Writes) ---
      for (const p of playerUpdates) {
        const nomeJogador = userMap[p.id] || 'Jogador Desconhecido';
        const userRef = db.collection('users').doc(p.id);
        
        transaction.update(userRef, { 
          xpTotal: admin.firestore.FieldValue.increment(p.xp), 
          campeonatosParticipados: admin.firestore.FieldValue.arrayUnion(champId) 
        });
        
        updates.push({ jogadorId: p.id, posicao: p.pos, xpGanho: p.xp, nome: nomeJogador });
        xpDistributed += p.xp;
      }
      
      if (updates.length > 0) {
        transaction.update(champRef, { 
          participantes: admin.firestore.FieldValue.arrayUnion(...updates),
          status: "finalizado"
        });
      } else {
        transaction.update(champRef, { status: "finalizado" });
      }
    });

    res.status(200).send({ message: `Lançamento customizado completo! Total de ${xpDistributed.toFixed(2)} XP distribuído.` });
  
  } catch (error) {
    console.error("Erro ao finalizar campeonato (custom):", error);
    res.status(500).send({ error: 'Erro ao finalizar campeonato customizado', details: error.message });
  }
});

// [ADMIN GLOBAL] Zera o XP de TODOS os usuários
app.post('/api/admin/ranking/reset', checkAuth, checkGlobalAdmin, async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    
    if (usersSnapshot.empty) {
      return res.status(200).send({ message: 'Nenhum usuário encontrado para resetar.' });
    }
    
    const batch = db.batch();
    let count = 0;
    
    // Itera por CADA documento na coleção 'users'
    usersSnapshot.forEach(doc => {
      const userRef = db.collection('users').doc(doc.id);
      
      // Define APENAS o campo 'xpTotal' como 0
      batch.update(userRef, { xpTotal: 0 }); 
      
      count++;
    });
    
    // Executa todas as atualizações de uma vez
    await batch.commit();
    
    res.status(200).send({ message: `Ranking resetado com sucesso! ${count} usuários tiveram seu XP zerado.` });
    
  } catch (error) {
    console.error("Erro ao resetar ranking:", error);
    res.status(500).send({ error: 'Erro ao resetar ranking', details: error.message });
  }
});

// [PÚBLICA] Retorna dados de UMA organização (para o novo form de admin)
app.get('/api/organizacoes/:id', async (req, res) => {
  try {
    const orgRef = db.collection('organizacoes').doc(req.params.id);
    const doc = await orgRef.get();
    
    if (!doc.exists) {
      return res.status(404).send({ error: 'Organização não encontrada' });
    }
    
    res.status(200).send(doc.data());
  } catch (error) {
    res.status(500).send({ error: 'Erro ao buscar organização', details: error.message });
  }
});

// [ADMIN] Atualiza os dados de uma organização
app.put('/api/organizacoes/:id', checkAuth, checkAdmin, async (req, res) => {
  const { nome, descricao, xpBase, imagemUrl } = req.body;
  const orgId = req.params.id;
  const adminUser = req.user.data;

  // Segurança: Só permite Admins Globais OU o dono da organização
  if (adminUser.admin !== true && adminUser.organizacaoId !== orgId) {
    return res.status(403).send({ error: 'Você não tem permissão para editar esta organização.' });
  }

  try {
    const orgRef = db.collection('organizacoes').doc(orgId);
    await orgRef.update({
      nome: nome,
      descricao: descricao,
      xpBase: Number(xpBase) || 1000, // Garante que é um número
      imagemUrl: imagemUrl
    });
    res.status(200).send({ message: 'Organização atualizada com sucesso!' });
  } catch (error) {
    res.status(500).send({ error: 'Erro ao atualizar organização', details: error.message });
  }
});

// [USUÁRIO LOGADO] Atualiza o perfil (foto, nome da equipe)
app.put('/api/users/profile', checkAuth, async (req, res) => {
  const { profileImageUrl, teamName } = req.body;
  const userId = req.user.uid;

  // Verifica se os dados recebidos são válidos
  if (typeof profileImageUrl !== 'string') {
    return res.status(400).send({ error: 'URL da imagem de perfil inválida.' });
  }

  try {
    const userRef = db.collection('users').doc(userId);
    const updateData = {
      profileImageUrl: profileImageUrl
    };

    // Só permite atualizar 'teamName' se o usuário for um jogador
    // E se o campo 'teamName' foi realmente enviado (não é undefined)
    if (req.user.data.tipo === 'jogador' && teamName !== undefined) {
      updateData.teamName = teamName;
    }

    await userRef.update(updateData);
    
    res.status(200).send({ message: 'Perfil atualizado com sucesso!' });

  } catch (error) {
    console.error("Erro ao atualizar perfil:", error);
    res.status(500).send({ error: 'Erro ao atualizar perfil', details: error.message });
  }
});

// --- Iniciar Servidor ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor backend rodando na porta ${PORT}`);
});