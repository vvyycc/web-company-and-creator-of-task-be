// src/routes/projects.ts
import express, { Request, Response } from 'express';
import { connectMongo } from '../db/mongo';
import { Subscription } from '../models/Subscription';

const router = express.Router();

type TaskCategory =
  | 'ARCHITECTURE'
  | 'MODEL'
  | 'SERVICE'
  | 'VIEW'
  | 'INFRA'
  | 'QA';

router.post('/generate-tasks', async (req: Request, res: Response) => {
  const { projectTitle, projectDescription, ownerEmail } = req.body || {};

  if (!projectTitle || !projectDescription || !ownerEmail) {
    return res.status(400).json({ error: 'Faltan datos del proyecto' });
  }

  try {
    await connectMongo();

    // 🔐 Check de suscripción
    const sub = await Subscription.findOne({ email: ownerEmail });
    console.log(
      '[generate-tasks] Suscripción encontrada para',
      ownerEmail,
      '=>',
      sub?.status
    );

    if (!sub || sub.status !== 'active') {
      return res.status(402).json({
        error: 'subscription_required',
        message:
          'Necesitas una suscripción activa de 30 €/mes para generar el troceado de tareas.',
      });
    }

    const hourlyRate = 30; // 30 €/hora

    // Heurística simple: nº de tareas según longitud de la descripción
    const wordCount = String(projectDescription).split(/\s+/).filter(Boolean).length;
    const numTasks = Math.min(6, Math.max(3, Math.round(wordCount / 40))); // 3–6 tareas

    const baseCategories: TaskCategory[] = [
      'ARCHITECTURE',
      'MODEL',
      'SERVICE',
      'VIEW',
      'INFRA',
      'QA',
    ];

    const tasks = Array.from({ length: numTasks }).map((_, index) => {
      const priority = index + 1;
      const category = baseCategories[index] ?? 'SERVICE';

      const estimatedHours =
        priority === 1
          ? 8 // arquitectura
          : priority === 2
          ? 10 // modelo/datos
          : priority === 3
          ? 12 // servicios principales
          : priority === 4
          ? 6 // vistas
          : priority === 5
          ? 4 // infra
          : 3; // QA / ajustes

      const taskPrice = estimatedHours * hourlyRate;

      return {
        id: `task-${priority}`,
        title: generarTituloTarea(priority, category),
        description: generarDescripcionTarea(
          priority,
          category,
          projectDescription
        ),
        category,
        complexity:
          estimatedHours <= 4 ? 'SIMPLE' : estimatedHours <= 8 ? 'MEDIUM' : 'HIGH',
        priority,
        estimatedHours,
        hourlyRate,
        taskPrice,
      };
    });

    tasks.sort((a, b) => a.priority - b.priority);

    const totalHours = tasks.reduce((acc, t) => acc + t.estimatedHours, 0);
    const totalTasksPrice = tasks.reduce((acc, t) => acc + t.taskPrice, 0);

    const platformFeePercent = 1;
    const platformFeeAmount = (totalTasksPrice * platformFeePercent) / 100;

    const generatorServiceFee = 0; // el generador se paga por suscripción, no por presupuesto
    const grandTotalClientCost =
      totalTasksPrice + platformFeeAmount + generatorServiceFee;

    return res.json({
      projectTitle,
      projectDescription,
      ownerEmail,
      tasks,
      totalHours,
      totalTasksPrice,
      platformFeePercent,
      platformFeeAmount,
      generatorServiceFee,
      grandTotalClientCost,
    });
  } catch (error) {
    console.error('Error generando tareas:', error);
    return res.status(500).json({ error: 'Error interno generando tareas' });
  }
});

function generarTituloTarea(priority: number, category: TaskCategory): string {
  switch (category) {
    case 'ARCHITECTURE':
      return 'Definir arquitectura y alcance inicial';
    case 'MODEL':
      return 'Diseñar modelos de datos y entidades clave';
    case 'SERVICE':
      return 'Implementar servicios y lógica de negocio principal';
    case 'VIEW':
      return 'Diseñar y maquetar vistas principales del frontend';
    case 'INFRA':
      return 'Configurar infraestructura, despliegue y entorno';
    case 'QA':
      return 'Diseñar estrategia de QA y pruebas';
    default:
      return `Tarea ${priority}`;
  }
}

function generarDescripcionTarea(
  priority: number,
  category: TaskCategory,
  projectDescription: string
): string {
  const base = projectDescription.slice(0, 200);

  switch (category) {
    case 'ARCHITECTURE':
      return `Analizar los requisitos y definir módulos y capas del sistema para "${base}"`;
    case 'MODEL':
      return `Identificar entidades, atributos y relaciones principales y diseñar el modelo de datos basado en: "${base}"`;
    case 'SERVICE':
      return `Implementar endpoints y servicios que resuelvan los casos de uso principales del proyecto (automatización, reglas de negocio, validaciones) según la descripción: "${base}"`;
    case 'VIEW':
      return `Crear las pantallas clave (formularios, listados, dashboards) conectadas con los servicios definidos para el caso de uso descrito.`;
    case 'INFRA':
      return `Configurar entorno (Docker/hosting), variables de entorno, logs y monitorización básica para asegurar despliegue estable del sistema.`;
    case 'QA':
      return `Diseñar y ejecutar pruebas (unitarias/integración) y definir checklist de validación antes de ir a producción.`;
    default:
      return `Implementar la parte ${priority} del proyecto en base a la descripción: "${base}"`;
  }
}

export default router;
