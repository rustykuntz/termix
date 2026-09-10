function hasProjectId(value) {
  return Object.prototype.hasOwnProperty.call(value || {}, 'projectId');
}

function sameSessionScope(left, right) {
  const leftHasProject = hasProjectId(left);
  const rightHasProject = hasProjectId(right);
  if (leftHasProject || rightHasProject) {
    return leftHasProject && rightHasProject
      && (left.projectId || null) === (right.projectId || null);
  }
  return left.cwd === right.cwd;
}

function projectName(projects, projectId) {
  return projects.find((project) => project.id === projectId)?.name || projectId;
}

function cwdGroupName(cwd) {
  const value = String(cwd || '').replace(/[\\/]+$/, '');
  if (!value) return '';
  return value.split(/[\\/]/).pop();
}

function sessionAddress(entry, projects) {
  const name = entry.name || entry.id;
  const scope = entry.projectId
    ? projectName(projects, entry.projectId)
    : cwdGroupName(entry.cwd);
  return scope ? `@${scope}/${name}` : name;
}

module.exports = {
  cwdGroupName,
  hasProjectId,
  projectName,
  sameSessionScope,
  sessionAddress,
};
